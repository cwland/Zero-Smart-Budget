import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { loginEvents, sessions } from "../db/schema.js";
import { TOKEN_LIFETIME_MS, hashApiKey, signToken } from "./auth.js";

// Signed-in devices and the sign-in history (Settings > Security).

const ua = (req: FastifyRequest) => (req.headers["user-agent"] ?? "").slice(0, 400) || null;

// The browser's own id (the X-Device-Id header; the page keeps a random one in localStorage)
export function deviceIdOf(req: FastifyRequest) {
  const v = req.headers["x-device-id"];
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null;
}

/**
 * Start a session for a sign-in and return its login token. Signing in again in the same browser
 * reuses that browser's row (with a new token; the old one stops working), so Signed-in devices
 * shows one row per browser.
 */
export async function startSession(db: Db, secret: string, req: FastifyRequest, user: { id: number; tokenVersion: number }, how: string, now = new Date()) {
  const tokenId = crypto.randomBytes(16).toString("base64url");
  const deviceId = deviceIdOf(req);
  const values = { tokenId, tokenVersion: user.tokenVersion, how, userAgent: ua(req), ip: req.ip, lastIp: req.ip, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS), revokedAt: null };
  const [row] = deviceId
    ? await db
        .insert(sessions)
        .values({ userId: user.id, deviceId, ...values })
        .onConflictDoUpdate({ target: [sessions.userId, sessions.deviceId], set: values })
        .returning()
    : await db
        .insert(sessions)
        .values({ userId: user.id, ...values })
        .returning();
  touched.delete(row.id);
  return { token: signToken(user.id, user.tokenVersion, secret, tokenId), session: row };
}

/** A fresh token for the same device (after the token version changed, e.g. a new password). */
export async function renewSession(db: Db, secret: string, user: { id: number; tokenVersion: number }, sessionId: number, now = new Date()) {
  const [row] = await db
    .update(sessions)
    .set({ tokenVersion: user.tokenVersion, expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS), revokedAt: null })
    .where(eq(sessions.id, sessionId))
    .returning();
  return signToken(user.id, user.tokenVersion, secret, row.tokenId);
}

// When each session was last marked as used (so every request doesn't write)
const touched = new Map<number, number>();
export const resetSessionTouches = () => touched.clear();

/**
 * The session behind a login token: null when it's been signed out. Tokens from before devices
 * were tracked get a session the first time they're used.
 */
export async function sessionForToken(
  db: Db,
  req: FastifyRequest,
  token: string,
  claims: { userId: number; tokenVersion: number; sid: string | null; iat: number | null; exp: number | null },
  now = new Date()
) {
  const tokenId = claims.sid ?? `legacy:${hashApiKey(token).slice(0, 40)}`;
  let [row] = await db.select().from(sessions).where(eq(sessions.tokenId, tokenId));
  if (!row) {
    if (claims.sid) return null; // a session that was deleted: signed out
    [row] = await db
      .insert(sessions)
      .values({
        userId: claims.userId,
        tokenId,
        tokenVersion: claims.tokenVersion,
        how: "earlier sign-in",
        userAgent: ua(req),
        ip: null,
        lastIp: req.ip,
        createdAt: claims.iat ? new Date(claims.iat * 1000) : now,
        lastSeenAt: now,
        expiresAt: claims.exp ? new Date(claims.exp * 1000) : new Date(now.getTime() + TOKEN_LIFETIME_MS),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) [row] = await db.select().from(sessions).where(eq(sessions.tokenId, tokenId));
  }
  if (row.revokedAt) return null;
  // A session from before browsers had an id: take this browser's id, unless it already has a row
  const deviceId = deviceIdOf(req);
  if (deviceId && !row.deviceId) {
    const [other] = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, row.userId), eq(sessions.deviceId, deviceId)));
    if (!other) {
      await db.update(sessions).set({ deviceId }).where(eq(sessions.id, row.id));
      row.deviceId = deviceId;
    }
  }
  const last = touched.get(row.id) ?? 0;
  if (Math.abs(now.getTime() - last) > 60 * 1000 || row.lastIp !== req.ip) {
    touched.set(row.id, now.getTime());
    await db.update(sessions).set({ lastSeenAt: now, lastIp: req.ip, ...(row.userAgent ? {} : { userAgent: ua(req) }) }).where(eq(sessions.id, row.id));
  }
  return row;
}

/** Sign out every session of a user (except one, to keep this device). */
export async function revokeAll(db: Db, userId: number, exceptId?: number, now = new Date()) {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptId ? sql`${sessions.id} <> ${exceptId}` : undefined));
}

/** Note a sign-in attempt. Keeps about a year of history. */
// Sign-in history is kept for this many days
export const LOGIN_LOG_DAYS = 60;
export const loginLogCutoff = (now = new Date()) => new Date(now.getTime() - LOGIN_LOG_DAYS * 24 * 60 * 60 * 1000);

export async function logSignIn(db: Db, req: FastifyRequest, e: { username: string | null; success: boolean; reason: string; sessionId?: number }) {
  await db.insert(loginEvents).values({ username: e.username?.slice(0, 100) ?? null, success: e.success, reason: e.reason, ip: req.ip, userAgent: ua(req), sessionId: e.sessionId ?? null });
  await pruneLoginLog(db);
}

// Drop sign-in history older than LOGIN_LOG_DAYS
export async function pruneLoginLog(db: Db, now = new Date()) {
  await db.delete(loginEvents).where(lt(loginEvents.at, loginLogCutoff(now)));
}

// "Chrome on Mac" from a browser's user agent (good enough to recognize your own devices)
export function describeDevice(userAgent: string | null) {
  if (!userAgent) return { browser: "Unknown browser", os: "unknown device", label: "Unknown device" };
  const u = userAgent;
  const os = /iPhone/.test(u)
    ? "iPhone"
    : /iPad/.test(u)
      ? "iPad"
      : /Android/.test(u)
        ? "Android"
        : /Mac OS X|Macintosh/.test(u)
          ? "Mac"
          : /Windows/.test(u)
            ? "Windows"
            : /CrOS/.test(u)
              ? "Chromebook"
              : /Linux/.test(u)
                ? "Linux"
                : "unknown device";
  const browser = /Edg\//.test(u)
    ? "Edge"
    : /OPR\/|Opera/.test(u)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(u)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(u)
          ? "Chrome"
          : /Safari\//.test(u)
            ? "Safari"
            : /^curl\//.test(u)
              ? "curl"
              : /node|undici|axios|python|Go-http/i.test(u)
                ? "A script"
                : "Unknown browser";
  return { browser, os, label: os === "unknown device" ? browser : `${browser} on ${os}` };
}
