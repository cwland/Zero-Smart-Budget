import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
    // Spending doesn't change what's still to plan
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
    // Moved to Deleted, not erased
    expect((await t.api("GET", `/api/transactions/${created.id}`)).body.deletedAt).toBeTruthy();
    expect((await t.api("DELETE", `/api/transactions/${created.id}?permanent=true`)).status).toBe(204);
    expect((await t.api("GET", `/api/transactions/${created.id}`)).status).toBe(404);
  });

  it("income on a budget item is money back: it lowers spent but isn't income", async () => {
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Target", amountCents: 8000, splits: [{ lineItemId: ids.household, amountCents: 8000 }] });
    const refund = await t.api("POST", "/api/transactions", { date: "2026-10-09", merchant: "Target refund", amountCents: 2500, type: "income", splits: [{ lineItemId: ids.household, amountCents: 2500 }] });
    expect(refund.status).toBe(201);
    const b = await budget();
    expect(item(b, ids.household)).toMatchObject({ spentCents: 5500, remainingCents: 4500 });
    expect(b.totals).toMatchObject({ spentCents: 5500, incomeReceivedCents: 0, leftToBudgetCents: 80000 });
  });

  it("an income transaction can be split between a paycheck and money back", async () => {
    await t.api("POST", "/api/transactions", {
      date: "2026-10-15", merchant: "Employer", amountCents: 151000, type: "income",
      splits: [{ incomeItemId: ids.pay, amountCents: 150000 }, { lineItemId: ids.groceries, amountCents: 1000 }],
    });
    const b = await budget();
    expect(b.income[0].receivedCents).toBe(150000);
    expect(item(b, ids.groceries).spentCents).toBe(-1000);
    expect(item(b, ids.groceries).remainingCents).toBe(61000);
  });

  it("expenses still can't go to income items", async () => {
    const res = await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "A", amountCents: 100, splits: [{ incomeItemId: ids.pay, amountCents: 100 }] });
    expect(res.status).toBe(400);
  });
});

describe("transaction list: search, item names, oldest", () => {
  const add = (b: any) => t.api("POST", "/api/transactions", b);
  beforeEach(async () => {
    await add({ date: "2026-10-05", merchant: "Trader Joe's", amountCents: 4250, note: "party snacks", splits: [{ lineItemId: ids.groceries, amountCents: 4250 }] });
    await add({ date: "2026-10-06", merchant: "Home Depot", amountCents: 120000, splits: [{ lineItemId: ids.household, amountCents: 120000 }] });
    await add({ date: "2026-10-15", merchant: "ACME PAYROLL", amountCents: 300000, type: "income", splits: [{ incomeItemId: ids.pay, amountCents: 300000 }] });
    await add({ date: "2026-08-02", merchant: "100% Pure_Juice", amountCents: 999 });
  });
  const search = async (q: string) => (await t.api("GET", `/api/transactions?q=${encodeURIComponent(q)}`)).body.map((r: any) => r.merchant);

  it("each split carries its item's name", async () => {
    const rows = (await t.api("GET", "/api/transactions?year=2026&month=10")).body;
    expect(rows.map((r: any) => r.splits.map((s: any) => s.itemName))).toEqual([["Paycheck"], ["Household"], ["Groceries"]]);
    expect(rows[0].splits[0]).not.toHaveProperty("incomeItem");
  });

  it("searches merchant, note, item and amount across all months", async () => {
    expect(await search("trader")).toEqual(["Trader Joe's"]);
    expect(await search("snacks")).toEqual(["Trader Joe's"]);
    expect(await search("groceries")).toEqual(["Trader Joe's"]);
    expect(await search("paycheck")).toEqual(["ACME PAYROLL"]);
    expect(await search("home depot")).toEqual(["Home Depot"]);
    expect(await search("depot home")).toEqual(["Home Depot"]); // words in any order
    expect(await search("42.50")).toEqual(["Trader Joe's"]);
    expect(await search("$1,200")).toEqual(["Home Depot"]);
    expect(await search("9.99")).toEqual(["100% Pure_Juice"]);
    expect(await search("100%")).toEqual(["100% Pure_Juice"]); // % and _ are literal, not wildcards
    expect(await search("e_j")).toEqual(["100% Pure_Juice"]);
    expect(await search("zzz")).toEqual([]);
  });

  it("knows the oldest transaction date", async () => {
    expect((await t.api("GET", "/api/transactions/oldest")).body).toEqual({ date: "2026-08-02" });
    await t.reset();
    await t.login();
    expect((await t.api("GET", "/api/transactions/oldest")).body).toEqual({ date: null });
  });
});

describe("deleted transactions", () => {
  const list = async (q = "") => (await t.api("GET", `/api/transactions${q}`)).body;

  it("delete moves it to Deleted: out of lists, budgets, suggestions, autocomplete and CSV", async () => {
    const tx = (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Zebra Store", amountCents: 5000, splits: [{ lineItemId: ids.groceries, amountCents: 5000 }] })).body;
    expect((await t.api("DELETE", `/api/transactions/${tx.id}`)).status).toBe(204);
    expect(await list("?year=2026&month=10")).toEqual([]);
    expect(item(await budget(), ids.groceries).spentCents).toBe(0);
    const deleted = await list("?deleted=true");
    expect(deleted.map((r: any) => [r.merchant, r.splits.length])).toEqual([["Zebra Store", 0]]);
    expect(deleted[0].deletedSplits).toEqual([{ lineItemId: ids.groceries, incomeItemId: null, amountCents: 5000 }]);
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Zebra%20Store&date=2026-10-20")).body.suggestion).toBeNull();
    expect((await t.api("GET", "/api/merchants?q=zebra")).body).toEqual([]);
    const csv = await t.app.inject({ method: "GET", url: "/api/export/transactions.csv", headers: { authorization: `Bearer ${t.getToken()}` } });
    expect(csv.body).not.toContain("Zebra");
    // Can't edit while deleted; deleting again changes nothing
    expect((await t.api("PUT", `/api/transactions/${tx.id}`, { date: "2026-10-05", merchant: "x", amountCents: 1 })).status).toBe(400);
    expect((await t.api("DELETE", `/api/transactions/${tx.id}`)).status).toBe(204);
    // Search only finds it in Deleted
    expect(await list("?q=zebra")).toEqual([]);
    expect((await list("?q=zebra&deleted=true")).length).toBe(1);
  });

  it("restore brings back its budget item, or unassigned if that item is gone", async () => {
    const a = (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Keep", amountCents: 5000, splits: [{ lineItemId: ids.groceries, amountCents: 3000 }, { lineItemId: ids.household, amountCents: 2000 }] })).body;
    const b = (await t.api("POST", "/api/transactions", { date: "2026-10-06", merchant: "Lose", amountCents: 1000, splits: [{ lineItemId: ids.rent, amountCents: 1000 }] })).body;
    await t.api("DELETE", `/api/transactions/${a.id}`);
    await t.api("DELETE", `/api/transactions/${b.id}`);
    await t.api("DELETE", `/api/items/${ids.rent}`);
    const ra = (await t.api("POST", `/api/transactions/${a.id}/restore`)).body;
    expect(ra.deletedAt).toBeNull();
    expect(ra.splits.map((s: any) => [s.lineItemId, s.amountCents])).toEqual([[ids.groceries, 3000], [ids.household, 2000]]);
    expect(item(await budget(), ids.groceries).spentCents).toBe(3000);
    const rb = (await t.api("POST", `/api/transactions/${b.id}/restore`)).body;
    expect(rb.splits).toEqual([]);
    expect((await list("?deleted=true"))).toEqual([]);
    expect((await t.api("POST", "/api/transactions/99999/restore")).status).toBe(404);
  });

  it("a deleted bank transaction isn't imported again, and backups keep deleted ones", async () => {
    const tx = (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Old", amountCents: 100 })).body;
    await t.api("DELETE", `/api/transactions/${tx.id}`);
    const backup = (await t.api("GET", "/api/export")).body;
    expect((await t.api("POST", "/api/import?confirm=replace", backup)).status).toBe(200);
    const after = await list("?deleted=true");
    expect(after).toHaveLength(1);
    expect(after[0].deletedAt).toBeTruthy();
  });
});


describe("check number, account and bank wording", () => {
  it("saves check # and account, and keeps them when not sent", async () => {
    const a = (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Landlord", amountCents: 1000, checkNumber: "1042", plaidAccountId: "acc-1" })).body;
    expect(a).toMatchObject({ checkNumber: "1042", plaidAccountId: "acc-1", originalDescription: null });
    const b = (await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-05", merchant: "Landlord", amountCents: 1000 })).body;
    expect(b).toMatchObject({ checkNumber: "1042", plaidAccountId: "acc-1" });
    const c = (await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-05", merchant: "Landlord", amountCents: 1000, checkNumber: "", plaidAccountId: null })).body;
    expect(c).toMatchObject({ checkNumber: null, plaidAccountId: null });
  });
  it("a bank-imported transaction keeps its account; everything else can still be edited", async () => {
    const a = (await t.api("POST", "/api/transactions", { date: "2026-10-25", merchant: "ACH Credit", amountCents: 250000, type: "income", plaidAccountId: "acc-1" })).body;
    await t.db.execute(sql`update transactions set plaid_transaction_id = 'bank-1' where id = ${a.id}`); // as if imported
    const moved = await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-25", merchant: "ACH Credit", amountCents: 250000, type: "income", plaidAccountId: "acc-2" });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/account/i);
    const cleared = await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-25", merchant: "ACH Credit", amountCents: 250000, type: "income", plaidAccountId: null });
    expect(cleared.status).toBe(400);
    // Same account (or none sent): the rest saves
    const edited = await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-31", merchant: "Paycheck", amountCents: 249000, type: "income", plaidAccountId: "acc-1" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ date: "2026-10-31", merchant: "Paycheck", amountCents: 249000, plaidAccountId: "acc-1" });
    expect((await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-31", merchant: "Paycheck", amountCents: 249000, type: "income" })).status).toBe(200);
  });

  it("a manually added transaction can change its account", async () => {
    const a = (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Cash", amountCents: 500, plaidAccountId: "acc-1" })).body;
    const b = await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-05", merchant: "Cash", amountCents: 500, plaidAccountId: "acc-2" });
    expect(b.status).toBe(200);
    expect(b.body.plaidAccountId).toBe("acc-2");
  });
});
