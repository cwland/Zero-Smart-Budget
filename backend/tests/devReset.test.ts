import { sql } from "drizzle-orm";
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  for (const f of fs.readdirSync(t.backupDir)) fs.unlinkSync(`${t.backupDir}/${f}`);
  await t.login();
  const fund = (await t.api("POST", "/api/funds", { name: "Car" })).body;
  const m = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
  const maint = m.groups.flatMap((g: any) => g.items).find((i: any) => i.name === "Maintenance");
  await t.api("PATCH", `/api/items/${maint.id}`, { plannedCents: 10000, sinkingFundId: fund.id });
  await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Jiffy", amountCents: 4000, splits: [{ lineItemId: maint.id, amountCents: 4000 }] });
  await t.api("POST", "/api/keys", { name: "n8n" });
});
afterAll(async () => t.close());

describe("testing reset", () => {
  it("needs RESET typed and a logged-in user", async () => {
    expect((await t.api("POST", "/api/dev/reset", { scope: "transactions", confirm: "reset" })).status).toBe(400);
    const key = (await t.api("POST", "/api/keys", { name: "x" })).body.key;
    t.setToken("");
    expect((await t.api("POST", "/api/dev/reset", { scope: "everything", confirm: "RESET" }, { "x-api-key": key })).status).toBe(403);
  });

  it("clear transactions keeps budgets and funds (minus spending), and backs up first", async () => {
    const res = await t.api("POST", "/api/dev/reset", { scope: "transactions", confirm: "RESET" });
    expect(res.body.backup).toMatch(/before-reset\.json$/);
    expect(fs.readdirSync(t.backupDir)).toContain(res.body.backup);
    expect((await t.api("GET", "/api/transactions")).body).toHaveLength(0);
    const b = (await t.api("GET", "/api/months/2026/10")).body;
    expect(b.exists).toBe(true);
    expect(b.totals.spentCents).toBe(0);
    expect((await t.api("GET", "/api/funds?year=2026&month=10")).body[0]).toMatchObject({ contributedCents: 10000, spentCents: 0, balanceCents: 10000 });
  });

  it("reset budget data keeps the login and API keys", async () => {
    await t.api("POST", "/api/dev/reset", { scope: "budget", confirm: "RESET" });
    expect((await t.api("GET", "/api/months")).body).toHaveLength(0);
    expect((await t.api("GET", "/api/funds?includeArchived=true")).body).toHaveLength(0);
    expect((await t.api("GET", "/api/keys")).body).toHaveLength(1);
    expect((await t.api("GET", "/api/auth/me")).status).toBe(200);
    // ids start over
    expect((await t.api("POST", "/api/months/2026/11", { mode: "blank" })).body.id).toBe(1);
  });

  it("reset everything goes back to first-run setup", async () => {
    await t.api("POST", "/api/dev/reset", { scope: "everything", confirm: "RESET" });
    expect((await t.api("GET", "/api/auth/status")).body.setupRequired).toBe(true);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
  });

  it("the backup can restore what was wiped", async () => {
    const res = await t.api("POST", "/api/dev/reset", { scope: "budget", confirm: "RESET" });
    const data = JSON.parse(fs.readFileSync(`${t.backupDir}/${res.body.backup}`, "utf8"));
    expect((await t.api("POST", "/api/import?confirm=replace", data)).status).toBe(200);
    expect((await t.api("GET", "/api/transactions")).body).toHaveLength(1);
  });

  it("bank transactions stay gone unless re-import is ticked", async () => {
    await t.db.execute(sql`insert into plaid_items (item_id, access_token_enc, env, institution_name, cursor, import_from) values ('it', 'x', 'sandbox', 'Bank', 'cur-9', '2026-10-01')`);
    await t.api("POST", "/api/dev/reset", { scope: "transactions", confirm: "RESET" });
    expect((await t.db.execute(sql`select cursor from plaid_items`)).rows[0]).toEqual({ cursor: "cur-9" });
    await t.api("POST", "/api/dev/reset", { scope: "transactions", confirm: "RESET", reimportBank: true });
    expect((await t.db.execute(sql`select cursor from plaid_items`)).rows[0]).toEqual({ cursor: null });
  });
});
