import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

// October with a "Car" fund ($200 starting) linked to Maintenance ($100 planned)
async function setup() {
  const fund = (await t.api("POST", "/api/funds", { name: "Car", targetCents: 100000, startingBalanceCents: 20000 })).body;
  const m = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
  const g = (await t.api("POST", `/api/months/${m.id}/groups`, { name: "Transportation" })).body;
  const item = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Maintenance", plannedCents: 10000, sinkingFundId: fund.id })).body;
  const other = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Gas", plannedCents: 5000 })).body;
  const spend = (await t.api("POST", "/api/transactions", { date: "2026-10-12", merchant: "Jiffy Lube", amountCents: 5000, splits: [{ lineItemId: item.id, amountCents: 5000 }] })).body;
  return { fund, m, g, item, other, spend };
}

const balance = async (fundId: number, year = 2026, month = 10) =>
  (await t.api("GET", `/api/funds?year=${year}&month=${month}&includeArchived=true`)).body.find((f: { id: number }) => f.id === fundId);
const entries = async (fundId: number) => (await t.api("GET", `/api/funds/${fundId}/entries`)).body;

describe("fund history", () => {
  it("records budgeted and spent entries for linked items", async () => {
    const { fund } = await setup();
    expect(await balance(fund.id)).toMatchObject({ contributedCents: 10000, spentCents: 5000, adjustmentsCents: 0, balanceCents: 25000 });
    const e = await entries(fund.id);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ kind: "spent", date: "2026-10-12", amountCents: -5000, description: "Jiffy Lube", live: true });
    expect(e[1]).toMatchObject({ kind: "budgeted", date: "2026-10-01", amountCents: 10000, description: "Maintenance", live: true });
  });

  it("follows changes while linked", async () => {
    const { fund, item, spend } = await setup();
    await t.api("PATCH", `/api/items/${item.id}`, { plannedCents: 15000 });
    await t.api("PUT", `/api/transactions/${spend.id}`, { date: "2026-10-12", merchant: "Jiffy Lube", amountCents: 7000, splits: [{ lineItemId: item.id, amountCents: 7000 }] });
    expect(await balance(fund.id)).toMatchObject({ contributedCents: 15000, spentCents: 7000, balanceCents: 28000 });

    // Deleting the transaction removes the spending
    await t.api("DELETE", `/api/transactions/${spend.id}`);
    expect((await balance(fund.id)).spentCents).toBe(0);
  });

  it("moving a transaction to a non-fund item removes its spending", async () => {
    const { fund, other, spend } = await setup();
    await t.api("PUT", `/api/transactions/${spend.id}`, { date: "2026-10-12", merchant: "Shell", amountCents: 5000, splits: [{ lineItemId: other.id, amountCents: 5000 }] });
    expect((await balance(fund.id)).spentCents).toBe(0);
  });

  it("unlinking keeps history, and later edits don't change it", async () => {
    const { fund, item, spend } = await setup();
    await t.api("PATCH", `/api/items/${item.id}`, { sinkingFundId: null });
    expect((await balance(fund.id)).balanceCents).toBe(25000);

    await t.api("PATCH", `/api/items/${item.id}`, { plannedCents: 99900 });
    await t.api("PUT", `/api/transactions/${spend.id}`, { date: "2026-10-12", merchant: "Jiffy Lube", amountCents: 9000, splits: [{ lineItemId: item.id, amountCents: 9000 }] });
    expect((await balance(fund.id)).balanceCents).toBe(25000);
    expect((await entries(fund.id)).every((e: { live: boolean }) => !e.live)).toBe(true);
  });

  it("relinking the same item doesn't count it twice", async () => {
    const { fund, item } = await setup();
    await t.api("PATCH", `/api/items/${item.id}`, { sinkingFundId: null });
    await t.api("PATCH", `/api/items/${item.id}`, { sinkingFundId: fund.id });
    expect(await balance(fund.id)).toMatchObject({ contributedCents: 10000, spentCents: 5000, balanceCents: 25000 });
    expect(await entries(fund.id)).toHaveLength(2);
  });

  it("deleting an item or its whole month keeps history", async () => {
    const { fund, item, m } = await setup();
    await t.api("DELETE", `/api/items/${item.id}`);
    expect((await balance(fund.id)).balanceCents).toBe(25000);
    await t.api("DELETE", `/api/months/${m.id}`);
    expect((await balance(fund.id)).balanceCents).toBe(25000);
  });

  it("switching an item to another fund moves its entries", async () => {
    const { fund, item } = await setup();
    const other = (await t.api("POST", "/api/funds", { name: "Vacation" })).body;
    await t.api("PATCH", `/api/items/${item.id}`, { sinkingFundId: other.id });
    expect((await balance(fund.id)).balanceCents).toBe(20000);
    expect(await balance(other.id)).toMatchObject({ contributedCents: 10000, spentCents: 5000, balanceCents: 5000 });
  });

  it("linking an item that already has spending picks it up", async () => {
    const { other } = await setup();
    const fund2 = (await t.api("POST", "/api/funds", { name: "Gas fund" })).body;
    await t.api("POST", "/api/transactions", { date: "2026-10-03", merchant: "Shell", amountCents: 3000, splits: [{ lineItemId: other.id, amountCents: 3000 }] });
    await t.api("PATCH", `/api/items/${other.id}`, { sinkingFundId: fund2.id });
    expect(await balance(fund2.id)).toMatchObject({ contributedCents: 5000, spentCents: 3000, balanceCents: 2000 });
  });

  it("copying a month adds the new month's money; balances are as-of the month", async () => {
    const { fund } = await setup();
    await t.api("POST", "/api/months/2026/11", { mode: "copy" });
    expect((await balance(fund.id, 2026, 10)).balanceCents).toBe(25000);
    expect((await balance(fund.id, 2026, 11)).balanceCents).toBe(35000);
  });

  it("split transactions record only the fund item's share", async () => {
    const { fund, item, other } = await setup();
    await t.api("POST", "/api/transactions", { date: "2026-10-20", merchant: "Costco", amountCents: 9000, splits: [{ lineItemId: item.id, amountCents: 2500 }, { lineItemId: other.id, amountCents: 6500 }] });
    expect((await balance(fund.id)).spentCents).toBe(7500);
  });
});

describe("adjustments", () => {
  it("adds and removes manual entries", async () => {
    const { fund } = await setup();
    const add = await t.api("POST", `/api/funds/${fund.id}/entries`, { date: "2026-10-15", amountCents: 5000, description: "Birthday money" });
    expect(add.status).toBe(201);
    await t.api("POST", `/api/funds/${fund.id}/entries`, { date: "2026-10-16", amountCents: -2000, description: "Moved to savings" });
    expect(await balance(fund.id)).toMatchObject({ adjustmentsCents: 3000, balanceCents: 28000 });

    expect((await t.api("DELETE", `/api/funds/${fund.id}/entries/${add.body.id}`)).status).toBe(204);
    expect((await balance(fund.id)).balanceCents).toBe(23000);
  });

  it("rejects zero and won't delete live entries", async () => {
    const { fund } = await setup();
    expect((await t.api("POST", `/api/funds/${fund.id}/entries`, { date: "2026-10-15", amountCents: 0 })).status).toBe(400);
    const live = (await entries(fund.id)).find((e: { kind: string }) => e.kind === "budgeted");
    const res = await t.api("DELETE", `/api/funds/${fund.id}/entries/${live.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("linked budget item");
  });

  it("frozen entries can be deleted", async () => {
    const { fund, item } = await setup();
    await t.api("DELETE", `/api/items/${item.id}`);
    const frozen = (await entries(fund.id)).find((e: { kind: string }) => e.kind === "budgeted");
    expect(frozen.live).toBe(false);
    expect((await t.api("DELETE", `/api/funds/${fund.id}/entries/${frozen.id}`)).status).toBe(204);
    expect((await balance(fund.id)).balanceCents).toBe(15000);
  });
});

describe("export / restore with history", () => {
  it("version 2 files carry history, including frozen entries", async () => {
    const { fund, item } = await setup();
    await t.api("PATCH", `/api/items/${item.id}`, { sinkingFundId: null });
    await t.api("POST", `/api/funds/${fund.id}/entries`, { date: "2026-10-15", amountCents: 1234 });
    const login = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
    const exported = (await t.app.inject({ method: "GET", url: "/api/export", headers: { authorization: `Bearer ${login.body.token}` } })).json();
    expect(exported.exportVersion).toBe(4);
    expect(exported.fundEntries).toHaveLength(3);

    await t.api("DELETE", `/api/funds/${fund.id}`);
    expect((await t.api("POST", "/api/import?confirm=replace", exported)).status).toBe(200);
    expect((await balance(fund.id)).balanceCents).toBe(25000 + 1234);
  });

  it("version 1 files rebuild history from links", async () => {
    const { fund } = await setup();
    const login = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
    const exported = (await t.app.inject({ method: "GET", url: "/api/export", headers: { authorization: `Bearer ${login.body.token}` } })).json();
    const v1 = { ...exported, exportVersion: 1 };
    delete v1.fundEntries;
    expect((await t.api("POST", "/api/import?confirm=replace", v1)).status).toBe(200);
    expect(await balance(fund.id)).toMatchObject({ contributedCents: 10000, spentCents: 5000, balanceCents: 25000 });
  });
});

describe("transfers into a fund ", () => {
  it("both sides of a transfer on the fund item cancel out; the fund keeps the planned deposit", async () => {
    const { fund, item } = await setup(); // Car fund: $200 starting, $100 planned, $50 spent
    await t.api("POST", "/api/transactions", { date: "2026-10-15", merchant: "Transfer to savings", amountCents: 10000, splits: [{ lineItemId: item.id, amountCents: 10000 }] });
    expect((await balance(fund.id)).balanceCents).toBe(15000); // only the - side so far
    await t.api("POST", "/api/transactions", { date: "2026-10-15", merchant: "Transfer from checking", amountCents: 10000, type: "income", splits: [{ lineItemId: item.id, amountCents: 10000 }] });
    expect(await balance(fund.id)).toMatchObject({ contributedCents: 10000, spentCents: 5000, balanceCents: 25000 });
    const e = await entries(fund.id);
    expect(e.find((x: { description: string }) => x.description === "Transfer from checking")).toMatchObject({ kind: "spent", amountCents: 10000, live: true });
  });

  it("a refund on a fund item puts money back", async () => {
    const { fund, item } = await setup();
    await t.api("POST", "/api/transactions", { date: "2026-10-20", merchant: "Jiffy Lube refund", amountCents: 2000, type: "income", splits: [{ lineItemId: item.id, amountCents: 2000 }] });
    expect(await balance(fund.id)).toMatchObject({ spentCents: 3000, balanceCents: 27000 });
  });
});
