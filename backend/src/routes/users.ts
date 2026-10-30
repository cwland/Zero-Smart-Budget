import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { invites, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { generateResetToken, hashApiKey, hashPassword } from "../lib/auth.js";
import { renderEmail } from "../lib/emailLayout.js";
import { invitation } from "../lib/emails.js";
import { logSignIn, startSession } from "../lib/sessions.js";
import { checkLockout, clearFailures, publicUser, recordFailure } from "./auth.js";
import { logEvent } from "../lib/appLog.js";

// Settings > Profile > Shared access (the owner only; see lib/roles.ts) and the invite sign-up page.

export const INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const email = z.string({ error: "Enter their email address" }).trim().min(1, "Enter their email address").email("That doesn't look like an email address").max(200);
const role = z.enum(["admin", "user"]);
const idParam = (req: FastifyRequest) => z.coerce.number().int().positive().parse((req.params as { id: string }).id);

function ownerId(req: FastifyRequest) {
  if (req.auth?.method !== "token" || req.auth.role !== "owner") throw new HttpError(403, "Only the account owner can manage shared access");
  return req.auth.userId;
}

export default async function userRoutes(app: FastifyInstance) {
  const { db, mail } = app;

  const inviteRow = (i: typeof invites.$inferSelect, now: Date) => ({
    id: i.id,
    name: i.name,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    expired: i.expiresAt <= now,
  });

  const appLink = async (token: string) => {
    const appUrl = (await mail.active())?.config.appUrl?.replace(/\/+$/, "");
    return appUrl ? `${appUrl}/#/invite?token=${token}` : null;
  };

  // Email the invite when email is set up with the app's address; otherwise the owner copies the link
  const sendInvite = async (inv: typeof invites.$inferSelect, token: string, fromId: number) => {
    const link = await appLink(token);
    if (!link) return { link: null, emailed: false, emailError: null as string | null };
    const [from] = await db.select().from(users).where(eq(users.id, fromId));
    try {
      const content = invitation({ from: from?.displayName || from?.username || "Someone", name: inv.name, role: inv.role, link, days: INVITE_DAYS });
      await mail.sendRendered(inv.email, renderEmail(content, { theme: from?.theme, appUrl: link.split("/#/")[0] }), "invite");
      return { link, emailed: true, emailError: null };
    } catch (e) {
      return { link, emailed: false, emailError: (e as Error).message.replace(/\s+/g, " ").slice(0, 300) };
    }
  };

  // Everyone with access, and the invites that haven't been used
  app.get("/api/users", async (req) => {
    ownerId(req);
    const now = app.now();
    const people = await db.select().from(users).orderBy(asc(users.id));
    const pending = await db.select().from(invites).where(isNull(invites.acceptedAt)).orderBy(desc(invites.createdAt));
    return {
      people: people.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt })),
      invites: pending.map((i) => inviteRow(i, now)),
      emailReady: !!(await appLink("x")),
    };
  });

  app.post("/api/users/invites", async (req) => {
    const from = ownerId(req);
    const body = z.object({ name: z.string().trim().max(100).optional().transform((v) => v || null), email, role }).strict().parse(req.body);
    const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    if (taken) throw new HttpError(409, "Someone with that email address already has access");
    // A new invite to the same address replaces the old one
    await db.delete(invites).where(and(isNull(invites.acceptedAt), sql`lower(${invites.email}) = ${body.email.toLowerCase()}`));
    const { token, hash } = generateResetToken();
    const [inv] = await db
      .insert(invites)
      .values({ tokenHash: hash, name: body.name, email: body.email, role: body.role, invitedBy: from, expiresAt: new Date(app.now().getTime() + INVITE_DAYS * DAY) })
      .returning();
    await logEvent(db, { category: "access", level: "info", source: "Shared access", event: `Invited ${body.email} as ${body.role === "admin" ? "an admin" : "a user"}` });
    return { invite: inviteRow(inv, app.now()), token, ...(await sendInvite(inv, token, from)) };
  });

  // A fresh link (the old one stops working), emailed again when email is set up
  app.post("/api/users/invites/:id/renew", async (req) => {
    const from = ownerId(req);
    const id = idParam(req);
    const { token, hash } = generateResetToken();
    const [inv] = await db
      .update(invites)
      .set({ tokenHash: hash, expiresAt: new Date(app.now().getTime() + INVITE_DAYS * DAY), invitedBy: from })
      .where(and(eq(invites.id, id), isNull(invites.acceptedAt)))
      .returning();
    if (!inv) throw new HttpError(404, "That invite isn't waiting anymore");
    return { invite: inviteRow(inv, app.now()), token, ...(await sendInvite(inv, token, from)) };
  });

  app.delete("/api/users/invites/:id", async (req, reply) => {
    ownerId(req);
    const [row] = await db.delete(invites).where(and(eq(invites.id, idParam(req)), isNull(invites.acceptedAt))).returning();
    if (!row) throw new HttpError(404, "That invite isn't waiting anymore");
    return reply.status(204).send();
  });

  // Change someone's role (the owner's own role can't change)
  app.patch("/api/users/:id", async (req) => {
    ownerId(req);
    const id = idParam(req);
    const body = z.object({ role }).strict().parse(req.body);
    const [u] = await db.update(users).set({ role: body.role }).where(and(eq(users.id, id), ne(users.role, "owner"))).returning();
    if (!u) throw new HttpError(404, "That person isn't on the list (the owner can't be changed)");
    await logEvent(db, { category: "access", level: "info", source: "Shared access", event: `${u.username} is now ${body.role === "admin" ? "an admin" : "a user"}` });
    return { id: u.id, role: u.role };
  });

  // Remove someone: their sign-in, devices and passkeys go; the shared budget stays as it is
  app.delete("/api/users/:id", async (req, reply) => {
    ownerId(req);
    const [u] = await db.delete(users).where(and(eq(users.id, idParam(req)), ne(users.role, "owner"))).returning();
    if (!u) throw new HttpError(404, "That person isn't on the list (the owner can't be removed)");
    await logEvent(db, { category: "access", level: "info", source: "Shared access", event: `Removed ${u.username}'s access` });
    return reply.status(204).send();
  });

  // ---------- the invite sign-up page (no login) ----------

  const findInvite = async (token: string) => {
    const [inv] = await db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, hashApiKey(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, app.now())));
    return inv ?? null;
  };

  app.get("/api/auth/invite", async (req) => {
    checkLockout(req);
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.query);
    const inv = await findInvite(token);
    if (!inv) {
      recordFailure(req);
      throw new HttpError(404, "This invite link is invalid or has expired. Ask for a new one.");
    }
    const [from] = inv.invitedBy ? await db.select().from(users).where(eq(users.id, inv.invitedBy)) : [];
    return { name: inv.name, email: inv.email, role: inv.role, from: from?.displayName || from?.username || null };
  });

  app.post("/api/auth/invite/accept", async (req) => {
    checkLockout(req);
    const body = z
      .object({
        token: z.string().min(10).max(200),
        username: z.string().trim().min(1, "Pick a username").max(100),
        password: z.string().min(8, "Password must be at least 8 characters").max(200),
        email: email.optional(),
      })
      .parse(req.body);
    const inv = await findInvite(body.token);
    if (!inv) {
      recordFailure(req);
      throw new HttpError(400, "This invite link is invalid or has expired. Ask for a new one.");
    }
    const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`);
    if (taken) throw new HttpError(409, "That username is taken");
    const [user] = await db
      .insert(users)
      .values({ username: body.username, displayName: inv.name, email: body.email ?? inv.email, passwordHash: await hashPassword(body.password), role: inv.role })
      .returning();
    await db.update(invites).set({ acceptedAt: app.now(), userId: user.id }).where(eq(invites.id, inv.id));
    clearFailures(req);
    const { token, session } = await startSession(db, app.jwtSecret, req, user, "invite", app.now());
    await logSignIn(db, req, { username: user.username, success: true, reason: "Joined with an invite", sessionId: session.id });
    await logEvent(db, { category: "access", level: "info", source: "Shared access", event: `${user.username} joined as ${user.role === "admin" ? "an admin" : "a user"}` });
    return { token, user: publicUser(user) };
  });
}
