import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

describe("sinking funds", () => {
  it("balance builds across months and drops when spent", async () => {
    const fund = (await t.api("POST", "/api/funds", { name: "Car repairs", targetCents: 100000, startingBalanceCents: 20000 })).body;

    const sep = (await t.api("POST", "/api/months/2026/9", { mode: "blank" })).body;
    const g = (await t.api("POST", `/api/months/${sep.id}/groups`, { name: "Savings" })).body;
    await t.api("POST", `/api/groups/${g.id}/items`, { name: "Car fund", plannedCents: 10000, sinkingFundId: fund.id });

    // October copies September, so the fund link carries forward
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "copy" })).body;
    const octItem = oct.groups[0].items[0];
    expect(octItem.sinkingFund).toMatchObject({ id: fund.id, balanceCents: 20000 + 10000 + 10000 });

    // Spend from it in October
    await t.api("POST", "/api/transactions", {
      date: "2026-10-12", merchant: "Jiffy Lube", amountCents: 7500, splits: [{ lineItemId: octItem.id, amountCents: 7500 }],
    });

    const asOfOct = (await t.api("GET", "/api/funds?year=2026&month=10")).body[0];
    expect(asOfOct).toMatchObject({ contributedCents: 20000, spentCents: 7500, balanceCents: 32500, targetCents: 100000 });

    // As of September only September's contribution counts
    const asOfSep = (await t.api("GET", "/api/funds?year=2026&month=9")).body[0];
    expect(asOfSep.contributedCents).toBe(10000);
  });

  it("archived funds are hidden unless asked for", async () => {
    const fund = (await t.api("POST", "/api/funds", { name: "Old" })).body;
    await t.api("PATCH", `/api/funds/${fund.id}`, { archived: true });
    expect((await t.api("GET", "/api/funds")).body).toHaveLength(0);
    expect((await t.api("GET", "/api/funds?includeArchived=true")).body).toHaveLength(1);
  });

  it("rejects linking to a fund that doesn't exist", async () => {
    const m = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
    const g = (await t.api("POST", `/api/months/${m.id}/groups`, { name: "Savings" })).body;
    expect((await t.api("POST", `/api/groups/${g.id}/items`, { name: "X", sinkingFundId: 999 })).status).toBe(400);
  });

  it("deleting a fund unlinks its line items", async () => {
    const fund = (await t.api("POST", "/api/funds", { name: "Gifts" })).body;
    const m = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
    const g = (await t.api("POST", `/api/months/${m.id}/groups`, { name: "Savings" })).body;
    await t.api("POST", `/api/groups/${g.id}/items`, { name: "Gifts", plannedCents: 5000, sinkingFundId: fund.id });
    expect((await t.api("DELETE", `/api/funds/${fund.id}`)).status).toBe(204);
    const b = (await t.api("GET", "/api/months/2026/10")).body;
    expect(b.groups[0].items[0]).toMatchObject({ name: "Gifts", sinkingFund: null });
  });
});

describe("export", () => {
  it("includes budget data but not the password or API keys", async () => {
    await t.api("POST", "/api/keys", { name: "n8n" });
    const m = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
    await t.api("POST", `/api/months/${m.id}/income`, { name: "Paycheck", plannedCents: 1 });
    const res = await t.app.inject({ method: "GET", url: "/api/export", headers: { authorization: (await login()) } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("corys-dollar-");
    const data = res.json();
    expect(data.months).toHaveLength(1);
    expect(data.incomeItems[0].name).toBe("Paycheck");
    expect(res.body).not.toContain("password");
    expect(data.apiKeys).toBeUndefined();
  });
});

async function login() {
  const res = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
  return `Bearer ${res.body.token}`;
}
