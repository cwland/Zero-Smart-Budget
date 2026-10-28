import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { apiKeys, users } from "./db/schema.js";
import { HttpError } from "./lib/errors.js";
import { hashApiKey, verifyToken } from "./lib/auth.js";
import authRoutes from "./routes/auth.js";
import keyRoutes from "./routes/keys.js";
import budgetRoutes from "./routes/budget.js";
import transactionRoutes from "./routes/transactions.js";
import fundRoutes from "./routes/funds.js";
import exportRoutes from "./routes/export.js";
import profileRoutes from "./routes/profile.js";
import settingsRoutes from "./routes/settings.js";
import devResetRoutes from "./routes/devReset.js"; // TEMPORARY testing tool
import { MailService, type EmailConfig, type TransportFactory } from "./lib/mail.js";
import { PlaidService, type PlaidFetch } from "./lib/plaid.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    jwtSecret: string;
    backupDir: string;
    backupKeep: number;
    mail: MailService;
    plaid: PlaidService;
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
  emailEnv?: EmailConfig | null; // email settings from .env (used when none are saved in the app)
  mailTransport?: TransportFactory; // tests swap in a fake
  plaidFetch?: PlaidFetch; // tests swap in a fake Plaid
}

// Backups go in <repo>/backups unless BACKUP_DIR says otherwise
export const defaultBackupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backups");

// Routes anyone can call without logging in
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/forgot",
  "POST /api/auth/reset",
]);

export function buildApp({ db, jwtSecret, logger = false, backupDir = defaultBackupDir, backupKeep = 30, emailEnv = null, mailTransport, plaidFetch }: AppOptions): FastifyInstance {
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error("JWT_SECRET must be set to at least 16 characters");
  }

  const app = Fastify({ logger });
  app.decorate("db", db);
  app.decorate("jwtSecret", jwtSecret);
  app.decorate("backupDir", backupDir);
  app.decorate("backupKeep", backupKeep);
  app.decorate("mail", new MailService(db, jwtSecret, emailEnv, mailTransport));
  app.decorate("plaid", new PlaidService(db, jwtSecret, plaidFetch));

  // Every /api route needs a login token or an API key, except the public ones
  app.addHook("onRequest", async (req) => {
    const route = `${req.method} ${req.routeOptions.url ?? req.url}`;
    if (!req.url.startsWith("/api/") || PUBLIC_ROUTES.has(route)) return;

    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const claims = verifyToken(header.slice(7), jwtSecret);
      if (claims) {
        // Tokens issued before the last "sign out everywhere" / password change no longer work
        const [user] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, claims.userId));
        if (user && user.tv === claims.tokenVersion) {
          req.auth = { method: "token", userId: claims.userId };
          return;
        }
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
  app.register(profileRoutes);
  app.register(settingsRoutes);
  app.register(devResetRoutes); // TEMPORARY testing tool

  return app;
}
