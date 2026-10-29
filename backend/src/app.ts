import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { apiKeys, users } from "./db/schema.js";
import { logEvent } from "./lib/appLog.js";
import logRoutes from "./routes/logs.js";
import { backupKeyFromEnv, type BackupSecrets } from "./lib/settingsBackup.js";
import { keyAllows, keyDenied, type KeyAccess } from "./lib/keyAccess.js";
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
import plaidRoutes from "./routes/plaid.js";
import accountRoutes from "./routes/accounts.js";
import devResetRoutes from "./routes/devReset.js"; // TEMPORARY testing tool
import { MailService, type EmailConfig, type TransportFactory } from "./lib/mail.js";
import { PlaidService, type PlaidFetch } from "./lib/plaid.js";
import { AiService, type AiFetch } from "./lib/ai.js";
import { markActive } from "./lib/notifications.js";
import { sessionForToken } from "./lib/sessions.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    jwtSecret: string;
    backupDir: string;
    backupKey: { key: string | null; problem: string | null };
    backupSecrets: () => BackupSecrets;
    backupKeep: number;
    mail: MailService;
    plaid: PlaidService;
    ai: AiService;
    now: () => Date; // the clock (tests set the date)
  }
  interface FastifyRequest {
    auth?: { method: "token"; userId: number; sessionId: number } | { method: "apiKey"; keyId: number };
  }
}

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  logger?: boolean;
  backupDir?: string;
  backupKey?: string; // BACKUP_KEY: encrypts saved keys and passwords inside backups
  backupKeep?: number;
  emailEnv?: EmailConfig | null; // email settings from .env (used when none are saved in the app)
  mailTransport?: TransportFactory; // tests swap in a fake
  plaidFetch?: PlaidFetch; // tests swap in a fake Plaid
  aiFetch?: AiFetch; // tests swap in a fake AI
  now?: () => Date; // tests set "today"
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

export function buildApp({ db, jwtSecret, logger = false, backupDir = defaultBackupDir, backupKeep = 30, backupKey = process.env.BACKUP_KEY, emailEnv = null, mailTransport, plaidFetch, aiFetch, now = () => new Date() }: AppOptions): FastifyInstance {
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error("JWT_SECRET must be set to at least 16 characters");
  }

  // Behind a proxy on this machine or the local network (Vite in development, a reverse proxy in
  // Docker), take the visitor's address from X-Forwarded-For so devices show their real IP
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal" });
  app.decorate("db", db);
  app.decorate("jwtSecret", jwtSecret);
  app.decorate("backupDir", backupDir);
  const bk = backupKeyFromEnv(backupKey);
  app.decorate("backupKey", bk);
  app.decorate("backupSecrets", () => ({ jwtSecret, backupKey: bk.key }));
  app.decorate("backupKeep", backupKeep);
  app.decorate("mail", new MailService(db, jwtSecret, emailEnv, mailTransport));
  app.decorate("plaid", new PlaidService(db, jwtSecret, plaidFetch));
  app.decorate("ai", new AiService(db, jwtSecret, aiFetch));
  app.decorate("now", now);

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
        // ...and its device hasn't been signed out
        const session = user && user.tv === claims.tokenVersion ? await sessionForToken(db, req, header.slice(7), claims, app.now()) : null;
        if (session) {
          req.auth = { method: "token", userId: claims.userId, sessionId: session.id };
          await markActive(db, claims.userId, app.now().getTime()); // for the "come back" nudge
          return;
        }
      }
    }

    const key = req.headers["x-api-key"];
    if (typeof key === "string" && key) {
      const [found] = await db
        .select({ id: apiKeys.id, name: apiKeys.name, access: apiKeys.access })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashApiKey(key)));
      if (found) {
        const access = found.access as KeyAccess;
        const path = req.routeOptions.url ?? req.url.split("?")[0];
        if (!keyAllows(access, req.method, path)) {
          await logEvent(db, { category: "api", level: "warning", source: `API key "${found.name}"`, event: `Refused ${req.method} ${path}: not allowed for this key`, detail: keyDenied(access, req.method) });
          throw new HttpError(403, keyDenied(access, req.method));
        }
        req.auth = { method: "apiKey", keyId: found.id };
        await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, found.id));
        return;
      }
      await logEvent(db, { category: "api", level: "warning", source: req.ip, event: `Refused ${req.method} ${req.url.split("?")[0]}: unknown API key`, detail: `The key started with ${key.slice(0, 6)}…` });
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
    void logEvent(db, { category: "api", level: "error", source: `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`, event: "Server error", detail: (err as Error).message });
    return reply.status(500).send({ error: "Something went wrong" });
  });

  app.get("/api/health", async () => ({ status: "ok", app: "Zero Smart Budget" }));

  app.register(authRoutes);
  app.register(keyRoutes);
  app.register(logRoutes);
  app.register(budgetRoutes);
  app.register(transactionRoutes);
  app.register(fundRoutes);
  app.register(exportRoutes);
  app.register(profileRoutes);
  app.register(settingsRoutes);
  app.register(plaidRoutes);
  app.register(accountRoutes);
  app.register(devResetRoutes); // TEMPORARY testing tool

  return app;
}
