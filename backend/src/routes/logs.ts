import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LOG_CATEGORIES, recentLogs } from "../lib/appLog.js";
import { HttpError } from "../lib/errors.js";

export default async function logRoutes(app: FastifyInstance) {
  // Settings > Logs (signed in only; never through an API key)
  app.get("/api/logs", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to see the logs");
    const q = z
      .object({ category: z.enum(LOG_CATEGORIES).optional(), problems: z.enum(["true", "false"]).optional() })
      .parse(req.query);
    return recentLogs(app.db, { category: q.category, problemsOnly: q.problems === "true" });
  });
}
