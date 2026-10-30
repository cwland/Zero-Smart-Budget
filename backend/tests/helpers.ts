import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { resetLoginLockouts } from "../src/routes/auth.js";
import { resetPasskeyChallenges } from "../src/routes/passkeys.js";
import { resetOAuthFlows } from "../src/routes/oauth.js";
import { resetOAuthCache } from "../src/lib/oauth.js";
import { resetActiveMark } from "../src/lib/notifications.js";
import { resetSessionTouches } from "../src/lib/sessions.js";
import type { EmailConfig, MailMessage } from "../src/lib/mail.js";
import type { PlaidFetch } from "../src/lib/plaid.js";
import type { UpdateFetch } from "../src/lib/updates.js";
import type { AiFetch } from "../src/lib/ai.js";

// Tests use their own database so they never touch your real budget.
// Create it once with: createdb corysdollar_test
const url = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/corysdollar_test";
if (!url.includes("test")) throw new Error("TEST_DATABASE_URL must point at a test database");

export async function setupTestApp(opts: { email?: boolean; backupKey?: string; jwtSecret?: string; oauthFetch?: typeof fetch; githubToken?: string } = {}) {
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
  // Fake AI: records calls; answer with ai.respond(url, body, headers) -> { status, json }
  const ai = {
    calls: [] as { url: string; method: string; headers: Record<string, string>; body: any }[],
    // (may return a promise, e.g. one that never settles to act like a server that hangs)
    respond: (_url: string, _body: any, _headers: Record<string, string>): { status: number; json: unknown } | Promise<{ status: number; json: unknown }> => ({ status: 200, json: { choices: [{ message: { content: '{"ok": true}' } }] } }),
    down: false,
  };
  const aiFetch: AiFetch = async (url, init) => {
    if (ai.down) throw new Error("ECONNREFUSED");
    const body = init.body ? JSON.parse(init.body) : undefined;
    ai.calls.push({ url, method: init.method, headers: init.headers, body });
    const r = await ai.respond(url, body, init.headers);
    return { ok: r.status < 300, status: r.status, json: async () => r.json };
  };
  // Fake GitHub releases: answer with github.respond(url, headers) -> { status, json }; down = unreachable
  const github = {
    calls: [] as { url: string; headers: Record<string, string> }[],
    down: false,
    token: null as string | null,
    respond: (_url: string, _headers: Record<string, string>): { status: number; json: unknown } => ({ status: 404, json: { message: "Not Found" } }),
  };
  const updateFetch: UpdateFetch = async (url, init) => {
    if (github.down) throw new Error("ECONNREFUSED");
    github.calls.push({ url, headers: init.headers });
    const r = github.respond(url, init.headers);
    return { status: r.status, json: async () => r.json };
  };
  // The app's clock ("today"); tests can set clock.date
  const clock = { date: null as Date | null };
  const app = buildApp({
    now: () => clock.date ?? new Date(),
    aiFetch,
    plaidFetch,
    updateFetch,
    updateRepo: "cwland/Corys_Dollar",
    githubToken: opts.githubToken ?? null,
    db,
    jwtSecret: opts.jwtSecret ?? "test-secret-that-is-long-enough",
    backupDir,
    backupKey: opts.backupKey ?? "",
    oauthFetch: opts.oauthFetch,
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
    ai,
    github,
    clock,
    async reset() {
      clock.date = null;
      sent.length = 0;
      failNext.value = "";
      plaid.calls.length = 0;
      ai.calls.length = 0;
      ai.down = false;
      ai.respond = () => ({ status: 200, json: { choices: [{ message: { content: '{"ok": true}' } }] } });
      github.calls.length = 0;
      github.down = false;
      github.respond = () => ({ status: 404, json: { message: "Not Found" } });
      plaid.down = false;
      plaid.respond = () => ({ status: 200, json: { link_token: "link-sandbox-test" } });
      await db.execute(sql`truncate users, password_resets, app_settings, plaid_items, api_keys, budget_months, sinking_funds, transactions, manual_accounts, notification_log, sessions, login_events, app_log, passkeys restart identity cascade`);
      resetSessionTouches();
      resetActiveMark();
      resetLoginLockouts();
      resetPasskeyChallenges();
      resetOAuthFlows();
      resetOAuthCache();
      token = "";
    },
    async login() {
      const res = await api("POST", "/api/auth/setup", { username: "cory", password: "password123", email: "cory@example.com" });
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
