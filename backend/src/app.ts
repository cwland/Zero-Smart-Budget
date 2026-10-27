import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { apiKeys } from "./db/schema.js";
import { HttpError } from "./lib/errors.js";
import { hashApiKey, verifyToken } from "./lib/auth.js";
import authRoutes from "./routes/auth.js";
import keyRoutes from "./routes/keys.js";
import budgetRoutes from "./routes/budget.js";
import transactionRoutes from "./routes/transactions.js";
import fundRoutes from "./routes/funds.js";
import exportRoutes from "./routes/export.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    jwtSecret: string;
    backupDir: string;
    backupKeep: number;
  }
  interface FastifyRequest {
    auth?: { method: "token"; userId: number } | { method: "apiKey"; keyId: number };
  }
}

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  logger?: boolean;
  backupDir?: string;
  backupKeep?: number;
}

// Backups go in <repo>/backups unless BACKUP_DIR says otherwise
export const defaultBackupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backups");

// Routes anyone can call without logging in
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
]);

export function buildApp({ db, jwtSecret, logger = false, backupDir = defaultBackupDir, backupKeep = 30 }: AppOptions): FastifyInstance {
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error("JWT_SECRET must be set to at least 16 characters");
  }

  const app = Fastify({ logger });
  app.decorate("db", db);
  app.decorate("jwtSecret", jwtSecret);
  app.decorate("backupDir", backupDir);
  app.decorate("backupKeep", backupKeep);

  // Every /api route needs a login token or an API key, except the public ones
  app.addHook("onRequest", async (req) => {
    const route = `${req.method} ${req.routeOptions.url ?? req.url}`;
    if (!req.url.startsWith("/api/") || PUBLIC_ROUTES.has(route)) return;

    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const userId = verifyToken(header.slice(7), jwtSecret);
      if (userId) {
        req.auth = { method: "token", userId };
        return;
      }
    }

    const key = req.headers["x-api-key"];
    if (typeof key === "string" && key) {
      const [found] = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashApiKey(key)));
      if (found) {
        req.auth = { method: "apiKey", keyId: found.id };
        await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, found.id));
        return;
      }
    }

    throw new HttpError(401, "Not logged in");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong" });
  });

  app.get("/api/health", async () => ({ status: "ok", app: "Cory's Dollar" }));

  app.register(authRoutes);
  app.register(keyRoutes);
  app.register(budgetRoutes);
  app.register(transactionRoutes);
  app.register(fundRoutes);
  app.register(exportRoutes);

  return app;
}
