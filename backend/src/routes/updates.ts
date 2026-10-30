import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

// Release watcher (the bar at the top of the app, and Settings > Data > Updates). Signed in only.
export default async function updateRoutes(app: FastifyInstance) {
  const { db, updates } = app;
  const requireLogin = (req: FastifyRequest) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Sign in to do this");
    return req.auth.userId;
  };
  const view = async (userId: number, s: Awaited<ReturnType<typeof updates.state>>) => {
    const [u] = await db.select({ dismissed: users.dismissedUpdate }).from(users).where(eq(users.id, userId));
    return { ...s, repo: updates.repo, dismissed: u?.dismissed ?? null };
  };

  // The latest release. check=1 (after signing in, and every 3 hours from the page): ask GitHub
  // again unless someone did in the last 10 minutes.
  app.get("/api/updates", async (req) => {
    const userId = requireLogin(req);
    const { check } = z.object({ check: z.enum(["0", "1"]).optional() }).parse(req.query);
    return view(userId, check === "1" ? await updates.check({ maxAgeMs: 10 * 60 * 1000 }) : await updates.state());
  });

  // Settings > Data > Check now
  app.post("/api/updates/check", async (req) => {
    const userId = requireLogin(req);
    return view(userId, await updates.check());
  });

  app.put("/api/updates/settings", async (req) => {
    const userId = requireLogin(req);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const s = await updates.setEnabled(enabled);
    return view(userId, enabled ? await updates.check() : s);
  });

  // Dismiss the bar for this version (it comes back for the next one)
  app.put("/api/updates/dismiss", async (req) => {
    const userId = requireLogin(req);
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict().parse(req.body);
    await db.update(users).set({ dismissedUpdate: version }).where(eq(users.id, userId));
    return view(userId, await updates.state());
  });
}
