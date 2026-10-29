import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { passkeys, users } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { describeDevice, logSignIn, startSession } from "../lib/sessions.js";
import { checkLockout, clearFailures, publicUser, recordFailure } from "./auth.js";

// Passkeys (WebAuthn): sign in with Touch ID / Face ID / Windows Hello / a phone instead of the
// password (which keeps working). A passkey belongs to the web address it was made on: the
// address comes from the browser's Origin header, so it works behind a reverse proxy (nginx)
// without settings. PASSKEY_ORIGINS (comma-separated, e.g. https://budget.example.com) limits
// which addresses may use passkeys at all.

const CHALLENGE_MS = 5 * 60 * 1000;
type Pending = { challenge: string; origin: string; rpId: string; purpose: "register" | "login"; userId?: number; expires: number };
const pending = new Map<string, Pending>();
export function resetPasskeyChallenges() {
  pending.clear();
}

const allowedOrigins = () =>
  (process.env.PASSKEY_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

// The address the browser is on: "https://budget.example.com" -> rpId "budget.example.com"
function siteOf(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) throw new HttpError(400, "Passkeys only work from a browser.");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new HttpError(400, "Passkeys only work from a browser.");
  }
  const allow = allowedOrigins();
  if (allow.length && !allow.includes(url.origin)) throw new HttpError(400, `Passkeys aren't allowed at ${url.origin}. Add it to PASSKEY_ORIGINS on the server.`);
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !local) throw new HttpError(400, "Passkeys need a secure address (https://, or localhost). Open the app through your HTTPS address to use them.");
  return { origin: url.origin, rpId: url.hostname };
}

function remember(p: Omit<Pending, "expires">) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const id = crypto.randomBytes(16).toString("base64url");
  pending.set(id, { ...p, expires: now + CHALLENGE_MS });
  return id;
}
function take(id: string, purpose: Pending["purpose"]) {
  const p = pending.get(id);
  pending.delete(id);
  if (!p || p.purpose !== purpose || p.expires < Date.now()) throw new HttpError(400, "That took too long. Try again.");
  return p;
}

const requireLogin = (req: FastifyRequest) => {
  if (req.auth?.method !== "token") throw new HttpError(403, "Sign in to manage passkeys");
  return req.auth.userId;
};

export default async function passkeyRoutes(app: FastifyInstance) {
  const { db } = app;

  // ---------- managing them (signed in) ----------

  app.get("/api/auth/passkeys", async (req) => {
    const userId = requireLogin(req);
    const rows = await db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.id));
    // (the page compares rpId with the address it's on: a plain GET doesn't say where the browser is)
    return rows.map((p) => ({ id: p.id, name: p.name, rpId: p.rpId, synced: p.backedUp, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  });

  app.post("/api/auth/passkeys/register/options", async (req) => {
    const userId = requireLogin(req);
    const { origin, rpId } = siteOf(req);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new HttpError(401, "Not logged in");
    const existing = await db.select().from(passkeys).where(and(eq(passkeys.userId, userId), eq(passkeys.rpId, rpId)));
    const options = await generateRegistrationOptions({
      rpName: "Zero Smart Budget",
      rpID: rpId,
      userName: user.username,
      userDisplayName: user.displayName ?? user.username,
      userID: new TextEncoder().encode(`zsb-user-${user.id}`),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = remember({ challenge: options.challenge, origin, rpId, purpose: "register", userId });
    return { challengeId, options };
  });

  app.post("/api/auth/passkeys/register/verify", async (req) => {
    const userId = requireLogin(req);
    const body = z.object({ challengeId: z.string(), response: z.any(), name: z.string().trim().max(60).optional() }).parse(req.body);
    const p = take(body.challengeId, "register");
    if (p.userId !== userId) throw new HttpError(400, "That took too long. Try again.");
    let result;
    try {
      result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: p.challenge, expectedOrigin: p.origin, expectedRPID: p.rpId, requireUserVerification: false });
    } catch (e) {
      throw new HttpError(400, `The passkey couldn't be added: ${(e as Error).message}`);
    }
    if (!result.verified) throw new HttpError(400, "The passkey couldn't be added.");
    const info = result.registrationInfo;
    const [row] = await db
      .insert(passkeys)
      .values({
        userId,
        credentialId: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        rpId: p.rpId,
        name: body.name || `Passkey on ${describeDevice(req.headers["user-agent"] ?? null).label}`,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, "That passkey is already added.");
    return { id: row.id, name: row.name, rpId: row.rpId };
  });

  app.patch("/api/auth/passkeys/:id", async (req) => {
    const userId = requireLogin(req);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { name } = z.object({ name: z.string().trim().min(1, "Give it a name").max(60) }).parse(req.body);
    const [row] = await db.update(passkeys).set({ name }).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning();
    if (!row) throw notFound("Passkey");
    return { id: row.id, name: row.name };
  });

  // Removes it here. (The passkey itself stays in your password manager / keychain until you delete it there.)
  app.delete("/api/auth/passkeys/:id", async (req, reply) => {
    const userId = requireLogin(req);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const gone = await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning({ id: passkeys.id });
    if (!gone.length) throw notFound("Passkey");
    return reply.status(204).send();
  });

  // ---------- signing in (public) ----------

  app.post("/api/auth/passkey/login/options", async (req) => {
    checkLockout(req);
    const { origin, rpId } = siteOf(req);
    // No list of allowed passkeys: the browser offers the ones it has for this address
    const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "preferred" });
    return { challengeId: remember({ challenge: options.challenge, origin, rpId, purpose: "login" }), options };
  });

  app.post("/api/auth/passkey/login/verify", async (req) => {
    const body = z.object({ challengeId: z.string(), response: z.object({ id: z.string() }).passthrough() }).parse(req.body);
    try {
      checkLockout(req);
    } catch (e) {
      await logSignIn(db, req, { username: null, success: false, reason: "Blocked: too many failed attempts" });
      throw e;
    }
    const p = take(body.challengeId, "login");
    const fail = async (reason: string, message = "That passkey didn't work. Try again, or sign in with your password.") => {
      recordFailure(req);
      await logSignIn(db, req, { username: null, success: false, reason });
      return new HttpError(401, message);
    };
    const [key] = await db.select().from(passkeys).where(and(eq(passkeys.credentialId, body.response.id), eq(passkeys.rpId, p.rpId)));
    if (!key) throw await fail("Unknown passkey", "This passkey isn't set up here. Sign in with your password, then add it in Settings > Security.");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: body.response as never,
        expectedChallenge: p.challenge,
        expectedOrigin: p.origin,
        expectedRPID: p.rpId,
        credential: { id: key.credentialId, publicKey: isoBase64URL.toBuffer(key.publicKey), counter: key.counter, transports: (key.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined },
        requireUserVerification: false,
      });
    } catch (e) {
      throw await fail(`Passkey check failed: ${(e as Error).message.slice(0, 120)}`);
    }
    if (!result.verified) throw await fail("Passkey check failed");
    await db
      .update(passkeys)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: app.now(), backedUp: result.authenticationInfo.credentialBackedUp })
      .where(eq(passkeys.id, key.id));
    const [user] = await db.select().from(users).where(eq(users.id, key.userId));
    if (!user) throw await fail("Passkey for a removed account");
    clearFailures(req);
    const { token, session } = await startSession(db, app.jwtSecret, req, user, "passkey", app.now());
    await logSignIn(db, req, { username: user.username, success: true, reason: `Signed in with passkey (${key.name})`, sessionId: session.id });
    return { token, user: publicUser(user) };
  });
}
