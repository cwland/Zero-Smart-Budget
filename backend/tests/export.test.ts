import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  for (const f of fs.readdirSync(t.backupDir)) fs.unlinkSync(`${t.backupDir}/${f}`);
  await t.login();
});
afterAll(async () => t.close());

async function sampleData() {
  const fund = (await t.api("POST", "/api/funds", { name: "Car", targetCents: 100000 })).body;
  const m = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
  const pay = (await t.api("POST", `/api/months/${m.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const g = (await t.api("POST", `/api/months/${m.id}/groups`, { name: "Food" })).body;
  const groceries = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Groceries", plannedCents: 60000 })).body;
  const car = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Car fund", plannedCents: 10000, sinkingFundId: fund.id })).body;
  await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Costco, Inc.", amountCents: 9000, splits: [{ lineItemId: groceries.id, amountCents: 6000 }, { lineItemId: car.id, amountCents: 3000 }] });
  await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "Employer", type: "income", amountCents: 150000, splits: [{ incomeItemId: pay.id, amountCents: 150000 }] });
  await t.api("POST", "/api/transactions", { date: "2026-10-07", merchant: "=HYPERLINK(\"x\")", amountCents: 500 });
  return { m, fund };
}

const raw = async (url: string) => {
  const login = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
  return t.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${login.body.token}` } });
};

describe("CSV export", () => {
  it("transactions: one row per split, quotes commas, defuses formulas", async () => {
    await sampleData();
    const res = await raw("/api/export/transactions.csv");
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe("Date,Merchant,Type,Total,Amount,Group,Item,Split,Note");
    expect(lines).toContain('2026-10-05,"Costco, Inc.",expense,90.00,60.00,Food,Groceries,yes,');
    expect(lines).toContain('2026-10-05,"Costco, Inc.",expense,90.00,30.00,Food,Car fund,yes,');
    expect(lines).toContain("2026-10-01,Employer,income,1500.00,1500.00,Income,Paycheck,,");
    expect(lines.find((l) => l.includes("HYPERLINK"))).toMatch(/^2026-10-07,"'=HYPERLINK/);
    expect(lines.find((l) => l.includes("HYPERLINK"))).toContain("Unassigned");
  });

  it("transactions can be limited by date", async () => {
    await sampleData();
    const res = await raw("/api/export/transactions.csv?from=2026-10-02&to=2026-10-06");
    expect(res.body.trim().split("\r\n")).toHaveLength(3); // header + 2 split rows
  });

  it("budget: planned/spent/remaining per item", async () => {
    await sampleData();
    const res = await raw("/api/export/budget.csv?year=2026&month=10");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe("Month,Group,Item,Planned,Spent/Received,Remaining,Sinking Fund");
    expect(lines).toContain("2026-10,Income,Paycheck,3000.00,1500.00,1500.00,");
    expect(lines).toContain("2026-10,Food,Groceries,600.00,60.00,540.00,");
    expect(lines).toContain("2026-10,Food,Car fund,100.00,30.00,70.00,Car");
  });
});

describe("backups", () => {
  it("backs up now, lists, downloads, and prunes to the keep limit", async () => {
    await sampleData();
    const made = await t.api("POST", "/api/backups");
    expect(made.status).toBe(201);
    expect(made.body.name).toMatch(/^zero-smart-budget-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);

    const list = await t.api("GET", "/api/backups");
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.keep).toBe(3);

    const dl = await raw(`/api/backups/${made.body.name}`);
    expect(dl.statusCode).toBe(200);
    expect(JSON.parse(dl.body).transactions).toHaveLength(3);

    // keep = 3: older files are removed
    for (let i = 0; i < 4; i++) fs.writeFileSync(`${t.backupDir}/zero-smart-budget-2020-01-0${i + 1}-000000.json`, "{}");
    await t.api("POST", "/api/backups");
    const after = (await t.api("GET", "/api/backups")).body.backups.map((b: { name: string }) => b.name);
    expect(after).toHaveLength(3);
    expect(after.some((n: string) => n.startsWith("zero-smart-budget-2020-01-01"))).toBe(false);
  });

  it("won't serve files outside the backup folder", async () => {
    expect((await raw("/api/backups/..%2F..%2Fpackage.json")).statusCode).toBe(404);
    expect((await raw("/api/backups/passwd")).statusCode).toBe(404);
  });
});

describe("restore", () => {
  it("round-trips: export, change things, restore, everything is back", async () => {
    await sampleData();
    const before = (await t.api("GET", "/api/months/2026/10")).body;
    const funds = (await t.api("GET", "/api/funds?year=2026&month=10")).body;
    const exported = JSON.parse((await raw("/api/export")).body);

    // Make a mess
    await t.api("DELETE", `/api/months/${before.id}`);
    await t.api("POST", "/api/months/2027/1", { mode: "template" });

    const res = await t.api("POST", "/api/import?confirm=replace", exported);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, months: 1, transactions: 3, sinkingFunds: 1 });
    expect(res.body.safetyBackup).toMatch(/before-restore\.json$/);

    expect((await t.api("GET", "/api/months/2026/10")).body).toEqual(before);
    expect((await t.api("GET", "/api/months/2027/1")).body.exists).toBe(false);
    expect((await t.api("GET", "/api/funds?year=2026&month=10")).body).toEqual(funds);

    // New rows get fresh ids after restore
    const g = (await t.api("POST", `/api/months/${before.id}/groups`, { name: "New" })).body;
    expect(g.id).toBeGreaterThan(Math.max(...before.groups.map((x: { id: number }) => x.id)));

    // Login still works (users aren't touched)
    expect((await t.api("GET", "/api/auth/me")).body.user.username).toBe("cory");
  });

  it("requires confirm=replace and a valid file, and leaves data alone otherwise", async () => {
    await sampleData();
    const exported = JSON.parse((await raw("/api/export")).body);
    expect((await t.api("POST", "/api/import", exported)).status).toBe(400);
    expect((await t.api("POST", "/api/import?confirm=replace", { hello: "world" })).status).toBe(400);

    // Broken references: nothing changes
    const broken = { ...exported, lineItems: [...exported.lineItems, { ...exported.lineItems[0], id: 999, groupId: 12345 }] };
    const res = await t.api("POST", "/api/import?confirm=replace", broken);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nothing was changed");
    expect((await t.api("GET", "/api/months/2026/10")).body.exists).toBe(true);
  });

  it("API keys can't restore", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    const exported = JSON.parse((await raw("/api/export")).body);
    t.setToken("");
    expect((await t.api("POST", "/api/import?confirm=replace", exported, { "x-api-key": key })).status).toBe(403);
  });
});
