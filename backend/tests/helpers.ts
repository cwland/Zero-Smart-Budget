import "dotenv/config";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";
import { resetLoginLockouts } from "../src/routes/auth.js";

// Tests use their own database so they never touch your real budget.
// Create it once with: createdb corysdollar_test
const url = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/corysdollar_test";
if (!url.includes("test")) throw new Error("TEST_DATABASE_URL must point at a test database");

export async function setupTestApp() {
  const { db, pool } = createDb(url);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const app = buildApp({ db, jwtSecret: "test-secret-that-is-long-enough" });
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
    async reset() {
      await db.execute(sql`truncate users, api_keys, budget_months, sinking_funds, transactions restart identity cascade`);
      resetLoginLockouts();
      token = "";
    },
    async login() {
      const res = await api("POST", "/api/auth/setup", { username: "cory", password: "password123" });
      token = res.body.token;
    },
    setToken(t: string) {
      token = t;
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof setupTestApp>>;
