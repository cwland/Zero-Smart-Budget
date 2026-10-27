import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let ids: { month: number; pay: number; rent: number; groceries: number; household: number };

beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
  const month = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
  const pay = (await t.api("POST", `/api/months/${month.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const g = (await t.api("POST", `/api/months/${month.id}/groups`, { name: "Spending" })).body;
  const rent = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Rent", plannedCents: 150000 })).body;
  const groceries = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Groceries", plannedCents: 60000 })).body;
  const household = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Household", plannedCents: 10000 })).body;
  ids = { month: month.id, pay: pay.id, rent: rent.id, groceries: groceries.id, household: household.id };
});
afterAll(async () => t.close());

const budget = async () => (await t.api("GET", "/api/months/2026/10")).body;
const item = (b: any, id: number) => b.groups.flatMap((g: any) => g.items).find((i: any) => i.id === id);

describe("transactions", () => {
  it("expense updates spent and remaining", async () => {
    const res = await t.api("POST", "/api/transactions", {
      date: "2026-10-05", merchant: "Costco", amountCents: 12345, splits: [{ lineItemId: ids.groceries, amountCents: 12345 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("expense");
    const b = await budget();
    expect(item(b, ids.groceries)).toMatchObject({ plannedCents: 60000, spentCents: 12345, remainingCents: 47655 });
    expect(b.groups[0]).toMatchObject({ spentCents: 12345, remainingCents: 220000 - 12345 });
    expect(b.totals.spentCents).toBe(12345);
    // Spending doesn't change left to budget
    expect(b.totals.leftToBudgetCents).toBe(80000);
  });

  it("split transaction counts toward each line item", async () => {
    await t.api("POST", "/api/transactions", {
      date: "2026-10-06", merchant: "Target", amountCents: 9000,
      splits: [{ lineItemId: ids.groceries, amountCents: 6000 }, { lineItemId: ids.household, amountCents: 3000 }],
    });
    const b = await budget();
    expect(item(b, ids.groceries).spentCents).toBe(6000);
    expect(item(b, ids.household).spentCents).toBe(3000);
  });

  it("income marks the income item received", async () => {
    await t.api("POST", "/api/transactions", {
      date: "2026-10-01", merchant: "Employer", amountCents: 150000, type: "income", splits: [{ incomeItemId: ids.pay, amountCents: 150000 }],
    });
    const b = await budget();
    expect(b.income[0].receivedCents).toBe(150000);
    expect(b.totals.incomeReceivedCents).toBe(150000);
  });

  it("rejects splits that don't add up, wrong type, or wrong month", async () => {
    const bad = [
      { date: "2026-10-05", merchant: "A", amountCents: 100, splits: [{ lineItemId: ids.groceries, amountCents: 99 }] },
      { date: "2026-10-05", merchant: "A", amountCents: 100, splits: [{ incomeItemId: ids.pay, amountCents: 100 }] },
      { date: "2026-10-05", merchant: "A", amountCents: 100, type: "income", splits: [{ lineItemId: ids.rent, amountCents: 100 }] },
      { date: "2026-11-05", merchant: "A", amountCents: 100, splits: [{ lineItemId: ids.groceries, amountCents: 100 }] },
      { date: "2026-10-05", merchant: "A", amountCents: 100, splits: [{ lineItemId: 99999, amountCents: 100 }] },
      { date: "2026-10-05", merchant: "A", amountCents: 100, splits: [{ lineItemId: ids.rent, incomeItemId: ids.pay, amountCents: 100 }] },
      { date: "10/05/2026", merchant: "A", amountCents: 100 },
      { date: "2026-10-05", merchant: "A", amountCents: 0 },
      { date: "2026-10-05", merchant: "A", amountCents: 1.5 },
    ];
    for (const body of bad) {
      const res = await t.api("POST", "/api/transactions", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("unassigned transactions show up in the unassigned filter", async () => {
    await t.api("POST", "/api/transactions", { date: "2026-10-07", merchant: "Mystery", amountCents: 500 });
    await t.api("POST", "/api/transactions", {
      date: "2026-10-08", merchant: "Costco", amountCents: 100, splits: [{ lineItemId: ids.groceries, amountCents: 100 }],
    });
    const res = await t.api("GET", "/api/transactions?unassigned=true");
    expect(res.body.map((x: any) => x.merchant)).toEqual(["Mystery"]);
  });

  it("deleting a line item leaves its transactions unassigned", async () => {
    await t.api("POST", "/api/transactions", {
      date: "2026-10-05", merchant: "Costco", amountCents: 100, splits: [{ lineItemId: ids.groceries, amountCents: 100 }],
    });
    await t.api("DELETE", `/api/items/${ids.groceries}`);
    const res = await t.api("GET", "/api/transactions?unassigned=true");
    expect(res.body).toHaveLength(1);
  });

  it("filters by month and line item, newest first", async () => {
    await t.api("POST", "/api/transactions", { date: "2026-10-02", merchant: "Old", amountCents: 1 });
    await t.api("POST", "/api/transactions", { date: "2026-10-20", merchant: "New", amountCents: 1, splits: [{ lineItemId: ids.rent, amountCents: 1 }] });
    await t.api("POST", "/api/transactions", { date: "2026-11-01", merchant: "Next month", amountCents: 1 });
    expect((await t.api("GET", "/api/transactions?year=2026&month=10")).body.map((x: any) => x.merchant)).toEqual(["New", "Old"]);
    expect((await t.api("GET", `/api/transactions?lineItemId=${ids.rent}`)).body.map((x: any) => x.merchant)).toEqual(["New"]);
  });

  it("edits replace splits, and delete removes spending", async () => {
    const created = (await t.api("POST", "/api/transactions", {
      date: "2026-10-05", merchant: "Costco", amountCents: 5000, splits: [{ lineItemId: ids.groceries, amountCents: 5000 }],
    })).body;
    const edited = await t.api("PUT", `/api/transactions/${created.id}`, {
      date: "2026-10-05", merchant: "Costco", amountCents: 7000, note: "fixed",
      splits: [{ lineItemId: ids.household, amountCents: 7000 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.splits).toHaveLength(1);
    let b = await budget();
    expect(item(b, ids.groceries).spentCents).toBe(0);
    expect(item(b, ids.household).spentCents).toBe(7000);

    expect((await t.api("DELETE", `/api/transactions/${created.id}`)).status).toBe(204);
    b = await budget();
    expect(item(b, ids.household).spentCents).toBe(0);
    expect((await t.api("GET", `/api/transactions/${created.id}`)).status).toBe(404);
  });
});
