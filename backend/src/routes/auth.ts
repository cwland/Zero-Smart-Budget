import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { users } from "../db/schema.js";
import { checkPassword, hashPassword, signToken } from "../lib/auth.js";
import { HttpError } from "../lib/errors.js";

const credentials = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

// Simple lockout: 5 failed logins from one address blocks it for 15 minutes
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; until: number }>();

function checkLockout(req: FastifyRequest) {
  const entry = failures.get(req.ip);
  if (entry && entry.count >= MAX_FAILURES && entry.until > Date.now()) {
    throw new HttpError(429, "Too many failed logins. Try again in 15 minutes.");
  }
}
function recordFailure(req: FastifyRequest) {
  const entry = failures.get(req.ip);
  const count = entry && entry.until > Date.now() ? entry.count + 1 : 1;
  failures.set(req.ip, { count, until: Date.now() + LOCKOUT_MS });
}

export function resetLoginLockouts() {
  failures.clear();
}

export default async function authRoutes(app: FastifyInstance) {
  const { db } = app;

  const userCount = async () => (await db.select({ n: count() }).from(users))[0].n;

  app.get("/api/auth/status", async () => ({ setupRequired: (await userCount()) === 0 }));

  // First run only: create the single account
  app.post("/api/auth/setup", async (req) => {
    const body = credentials.parse(req.body);
    if ((await userCount()) > 0) throw new HttpError(409, "Account already set up");
    const [user] = await db
      .insert(users)
      .values({ username: body.username, passwordHash: await hashPassword(body.password) })
      .returning({ id: users.id, username: users.username });
    return { token: signToken(user.id, app.jwtSecret), user };
  });

  app.post("/api/auth/login", async (req) => {
    checkLockout(req);
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.username, body.username.trim()));
    if (!user || !(await checkPassword(body.password, user.passwordHash))) {
      recordFailure(req);
      throw new HttpError(401, "Wrong username or password");
    }
    failures.delete(req.ip);
    return { token: signToken(user.id, app.jwtSecret), user: { id: user.id, username: user.username } };
  });

  app.get("/api/auth/me", async (req) => {
    if (req.auth?.method !== "token") return { method: "apiKey" };
    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, req.auth.userId));
    if (!user) throw new HttpError(401, "Not logged in");
    return { method: "token", user };
  });

  app.post("/api/auth/password", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to change the password");
    const body = z
      .object({ currentPassword: z.string(), newPassword: credentials.shape.password })
      .parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId));
    if (!user || !(await checkPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, "Current password is wrong");
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword) })
      .where(eq(users.id, user.id));
    return { ok: true };
  });
}
