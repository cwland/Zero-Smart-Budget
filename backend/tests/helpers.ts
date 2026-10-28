import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { resetLoginLockouts } from "../src/routes/auth.js";
import type { EmailConfig, MailMessage } from "../src/lib/mail.js";
import type { PlaidFetch } from "../src/lib/plaid.js";

// Tests use their own database so they never touch your real budget.
// Create it once with: createdb corysdollar_test
const url = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/corysdollar_test";
if (!url.includes("test")) throw new Error("TEST_DATABASE_URL must point at a test database");

export async function setupTestApp(opts: { email?: boolean } = {}) {
  const { db, pool } = createDb(url);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-backups-"));
  // Fake mail transport: records messages (and the settings used) instead of sending
  const sent: (MailMessage & { from: string; config: EmailConfig })[] = [];
  const failNext = { value: "" };
  const emailEnv: EmailConfig | null =
    opts.email === false
      ? null
      : { host: "env.smtp", port: 25, security: "none", username: null, password: null, fromName: null, fromAddress: "app@test", appUrl: "http://budget.test" };
  // Fake Plaid: records calls; answer with plaid.respond(path, body) -> { status, json }
  const plaid = {
    calls: [] as { url: string; body: any }[],
    respond: (_path: string, _body: any): { status: number; json: unknown } => ({ status: 200, json: { link_token: "link-sandbox-test" } }),
    down: false,
  };
  const plaidFetch: PlaidFetch = async (url, init) => {
    if (plaid.down) throw new Error("ECONNREFUSED");
    const body = JSON.parse(init.body);
    plaid.calls.push({ url, body });
    const r = plaid.respond(new URL(url).pathname, body);
    return { ok: r.status < 300, status: r.status, json: async () => r.json };
  };
  const app = buildApp({
    plaidFetch,
    db,
    jwtSecret: "test-secret-that-is-long-enough",
    backupDir,
    backupKeep: 3,
    emailEnv,
    mailTransport: (config) => ({
      sendMail: async (m) => {
        if (failNext.value) {
          const msg = failNext.value;
          failNext.value = "";
          throw new Error(msg);
        }
        sent.push({ ...m, config });
      },
    }),
  });
  await app.ready();

  let token = "";

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url: path,
      payload: body as object,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };

  return {
    app,
    db,
    api,
    backupDir,
    sent,
    failNext,
    plaid,
    async reset() {
      sent.length = 0;
      failNext.value = "";
      plaid.calls.length = 0;
      plaid.down = false;
      plaid.respond = () => ({ status: 200, json: { link_token: "link-sandbox-test" } });
      await db.execute(sql`truncate users, password_resets, app_settings, api_keys, budget_months, sinking_funds, transactions restart identity cascade`);
      resetLoginLockouts();
      token = "";
    },
    async login() {
      const res = await api("POST", "/api/auth/setup", { username: "cory", password: "password123" });
      token = res.body.token;
    },
    getToken: () => token,
    setToken(t: string) {
      token = t;
    },
    async close() {
      fs.rmSync(backupDir, { recursive: true, force: true });
      await app.close();
      await pool.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof setupTestApp>>;
