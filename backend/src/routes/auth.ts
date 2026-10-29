import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { checkPassword, generateResetToken, hashApiKey, hashPassword } from "../lib/auth.js";
import { describeDevice, logSignIn, renewSession, revokeAll, startSession } from "../lib/sessions.js";
import { loginEvents, passwordResets, sessions, users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

const password = z.string().min(8, "Password must be at least 8 characters").max(200);
const credentials = z.object({ username: z.string().trim().min(1).max(100), password });

const RESET_LIFETIME_MS = 60 * 60 * 1000; // reset links work for 1 hour

// Simple lockout: 5 failed logins from one address blocks it for 15 minutes
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; until: number }>();
// At most one reset email per minute, and 5 per hour
let resetSends: number[] = [];

function checkLockout(req: FastifyRequest) {
  const entry = failures.get(req.ip);
  if (entry && entry.count >= MAX_FAILURES && entry.until > Date.now()) {
    throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
  }
}
function recordFailure(req: FastifyRequest) {
  const entry = failures.get(req.ip);
  const n = entry && entry.until > Date.now() ? entry.count + 1 : 1;
  failures.set(req.ip, { count: n, until: Date.now() + LOCKOUT_MS });
}

export function resetLoginLockouts() {
  failures.clear();
  resetSends = [];
}

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  email: u.email,
});

export default async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  const userCount = async () => (await db.select({ n: count() }).from(users))[0].n;
  const emailEnabled = () => app.mail.canSendLinks();

  app.get("/api/auth/status", async () => {
    const [user] = await db.select({ email: users.email }).from(users).limit(1);
    const enabled = await emailEnabled();
    return {
      setupRequired: !user,
      emailEnabled: enabled,
      resetAvailable: enabled && !!user?.email,
    };
  });

  // First run only: create the single account
  app.post("/api/auth/setup", async (req) => {
    const body = credentials.parse(req.body);
    if ((await userCount()) > 0) throw new HttpError(409, "Account already set up");
    const [user] = await db
      .insert(users)
      .values({ username: body.username, passwordHash: await hashPassword(body.password) })
      .returning();
    const { token, session } = await startSession(db, app.jwtSecret, req, user, "account set up", app.now());
    await logSignIn(db, req, { username: user.username, success: true, reason: "Account set up", sessionId: session.id });
    return { token, user: publicUser(user) };
  });

  app.post("/api/auth/login", async (req) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    try {
      checkLockout(req);
    } catch (e) {
      await logSignIn(db, req, { username: body.username, success: false, reason: "Blocked: too many failed attempts" });
      throw e;
    }
    const [user] = await db.select().from(users).where(sql`lower(${users.username}) = ${body.username.trim().toLowerCase()}`); // usernames ignore capitalization
    if (!user || !(await checkPassword(body.password, user.passwordHash))) {
      recordFailure(req);
      await logSignIn(db, req, { username: body.username, success: false, reason: user ? "Wrong password" : "Unknown username" });
      throw new HttpError(401, "Wrong username or password");
    }
    failures.delete(req.ip);
    const { token, session } = await startSession(db, app.jwtSecret, req, user, "password", app.now());
    await logSignIn(db, req, { username: body.username, success: true, reason: "Signed in with password", sessionId: session.id });
    return { token, user: publicUser(user) };
  });

  app.get("/api/auth/me", async (req) => {
    if (req.auth?.method !== "token") return { method: "apiKey" };
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId));
    if (!user) throw new HttpError(401, "Not logged in");
    return { method: "token", user: publicUser(user) };
  });

  // Change password. Signs out every other device; returns a fresh token for this one.
  app.post("/api/auth/password", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to change the password");
    const body = z.object({ currentPassword: z.string(), newPassword: password }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId));
    if (!user || !(await checkPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, "Current password is wrong");
    }
    const [updated] = await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id))
      .returning();
    await revokeAll(db, user.id, req.auth.sessionId, app.now());
    return { ok: true, token: await renewSession(db, app.jwtSecret, updated, req.auth.sessionId, app.now()) };
  });

  // Sign out everywhere. With keepThisDevice, returns a fresh token so this browser stays in.
  app.post("/api/auth/logout-all", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
    const body = z.object({ keepThisDevice: z.boolean().default(false) }).parse(req.body ?? {});
    const [updated] = await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, req.auth.userId))
      .returning();
    await revokeAll(db, updated.id, body.keepThisDevice ? req.auth.sessionId : undefined, app.now());
    return { ok: true, token: body.keepThisDevice ? await renewSession(db, app.jwtSecret, updated, req.auth.sessionId, app.now()) : undefined };
  });

  // Sign out this device
  app.post("/api/auth/logout", async (req) => {
    if (req.auth?.method !== "token") return { ok: true };
    await db.update(sessions).set({ revokedAt: app.now() }).where(eq(sessions.id, req.auth.sessionId));
    return { ok: true };
  });

  // ---------- signed-in devices and sign-in history (Settings > Security) ----------

  app.get("/api/auth/sessions", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
    const auth = req.auth;
    const [user] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, auth.userId));
    const now = app.now();
    const rows = await db.select().from(sessions).where(eq(sessions.userId, auth.userId)).orderBy(desc(sessions.lastSeenAt)).limit(100);
    return rows.map((s) => {
      const status = s.revokedAt || s.tokenVersion !== user.tv ? "signed out" : s.expiresAt < now ? "expired" : "active";
      return {
        id: s.id,
        current: s.id === auth.sessionId,
        status,
        device: describeDevice(s.userAgent),
        userAgent: s.userAgent,
        how: s.how,
        ip: s.ip,
        lastIp: s.lastIp,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        signedOutAt: s.revokedAt,
      };
    });
  });

  // Sign out one device
  app.delete("/api/auth/sessions/:id", async (req, reply) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const [row] = await db
      .update(sessions)
      .set({ revokedAt: app.now() })
      .where(and(eq(sessions.id, id), eq(sessions.userId, req.auth.userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!row) throw new HttpError(404, "That device isn't signed in");
    return reply.status(204).send();
  });

  app.get("/api/auth/logins", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
    const rows = await db.select().from(loginEvents).orderBy(desc(loginEvents.at), desc(loginEvents.id)).limit(200);
    return rows.map((e) => ({ ...e, device: describeDevice(e.userAgent) }));
  });

  // Email a reset link to the account's address. Always answers the same way, so it
  // never reveals whether an address is on file.
  app.post("/api/auth/forgot", async (req) => {
    const active = await app.mail.active();
    if (!active?.config.appUrl) throw new HttpError(400, "Email isn't set up on this server. Use `npm run reset-password` on the server instead.");
    const now = Date.now();
    resetSends = resetSends.filter((t) => now - t < 60 * 60 * 1000);
    if (resetSends.some((t) => now - t < 60 * 1000) || resetSends.length >= 5) {
      throw new HttpError(429, "A reset email was sent recently. Check your inbox, or try again in a few minutes.");
    }

    const [user] = await db.select().from(users).limit(1);
    if (user?.email) {
      resetSends.push(now);
      // Only the newest link works
      await db.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
      const { token, hash } = generateResetToken();
      await db.insert(passwordResets).values({ userId: user.id, tokenHash: hash, expiresAt: new Date(now + RESET_LIFETIME_MS) });
      const link = `${active.config.appUrl}/#/reset?token=${token}`;
      try {
        await app.mail.send({
          to: user.email,
          subject: "Reset your ZeroPoint Budget password",
          text: `Someone (hopefully you) asked to reset the password for "${user.username}".\n\nReset it here (this link works once, for 1 hour):\n${link}\n\nIf this wasn't you, you can ignore this email. Your password won't change.`,
          html: `<p>Someone (hopefully you) asked to reset the password for <strong>${user.username.replace(/[<>&]/g, "")}</strong>.</p><p><a href="${link}">Reset your password</a> (this link works once, for 1 hour).</p><p>If this wasn't you, you can ignore this email. Your password won't change.</p>`,
        });
      } catch (err) {
        req.log.error(err);
        throw new HttpError(502, "Couldn't send the email. Check the email settings on the server.");
      }
    }
    return { ok: true };
  });

  // Use a reset link: set a new password, sign out everywhere, and sign in here
  app.post("/api/auth/reset", async (req) => {
    checkLockout(req);
    const body = z.object({ token: z.string().min(10).max(200), newPassword: password }).parse(req.body);
    const [reset] = await db
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.tokenHash, hashApiKey(body.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())));
    if (!reset) {
      recordFailure(req);
      throw new HttpError(400, "This reset link is invalid or has expired. Ask for a new one.");
    }
    await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, reset.id));
    const [user] = await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, reset.userId))
      .returning();
    await revokeAll(db, user.id, undefined, app.now());
    const { token, session } = await startSession(db, app.jwtSecret, req, user, "password reset link", app.now());
    await logSignIn(db, req, { username: user.username, success: true, reason: "Reset the password with an email link", sessionId: session.id });
    return { token, user: publicUser(user) };
  });
}
