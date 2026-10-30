import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { normalizeMerchant, backfillMerchantKeys } from "../src/lib/merchant.js";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

describe("normalizeMerchant", () => {
  it("strips card numbers, refs, dates and bank words", () => {
    expect(normalizeMerchant("ACH CREDIT HOMEDEPOT *4986 10/13")).toBe("homedepot");
    expect(normalizeMerchant("ACH Credit HomeDepot *4986 09/12")).toBe("homedepot");
    expect(normalizeMerchant("POS DEBIT TRADER JOE'S #552 BOISE ID")).toBe("trader joes boise");
    expect(normalizeMerchant("Trader Joe's #118 Boise")).toBe("trader joes boise");
    expect(normalizeMerchant("Shell Oil 57442 - Fuel")).toBe("shell oil fuel");
    expect(normalizeMerchant("12345")).toBe("");
  });
});

// October and November budgets with the same items
async function twoMonths() {
  const oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
  const nov = (await t.api("POST", "/api/months/2026/11", { mode: "copy" })).body;
  const find = (b: any, name: string) => b.groups.flatMap((g: any) => g.items).find((i: any) => i.name === name);
  return { oct, nov, find, octPay2: oct.income[1], novPay2: nov.income[1] };
}

describe("suggestions", () => {
  it("suggests last month's item for the same merchant, in this month", async () => {
    const { oct, nov, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "POS DEBIT TRADER JOE'S #552", amountCents: 5000, splits: [{ lineItemId: find(oct, "Groceries").id, amountCents: 5000 }] });
    const created = (await t.api("POST", "/api/transactions", { date: "2026-11-03", merchant: "POS DEBIT TRADER JOE'S #118", amountCents: 6100 })).body;

    const list = (await t.api("GET", "/api/transactions?year=2026&month=11")).body;
    const row = list.find((x: any) => x.id === created.id);
    expect(row.suggestion).toEqual({ lineItemId: find(nov, "Groceries").id, itemName: "Groceries", groupName: "Food" });
  });

  it("Quick Assign's old name (fastTrack) still works: saved settings, restored backups and the API", async () => {
    await t.db.execute(sql`insert into app_settings (key, value) values ('budget', '{"fastTrack": false, "tossAnimation": true}')`);
    expect((await t.api("GET", "/api/settings/budget")).body).toEqual({ quickAssign: false, tossAnimation: true, monthCloseDays: 4, monthCloseEnabled: true, monthCloseAuto: true });
    expect((await t.api("PUT", "/api/settings/budget", { fastTrack: true })).body.quickAssign).toBe(true);
    const [row] = (await t.db.execute(sql`select value from app_settings where key = 'budget'`)).rows as any[];
    expect(row.value).not.toHaveProperty("fastTrack");
  });

  it("Quick Assign off: no suggestions, no auto-assign; back on restores them", async () => {
    expect((await t.api("GET", "/api/settings/budget")).body).toEqual({ quickAssign: true, tossAnimation: true, monthCloseDays: 4, monthCloseEnabled: true, monthCloseAuto: true });
    const { oct, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Trader Joe's", amountCents: 5000, splits: [{ lineItemId: find(oct, "Groceries").id, amountCents: 5000 }] });
    const created = (await t.api("POST", "/api/transactions", { date: "2026-11-03", merchant: "Trader Joe's", amountCents: 6100 })).body;

    expect((await t.api("PUT", "/api/settings/budget", { quickAssign: false })).body).toEqual({ quickAssign: false, tossAnimation: true, monthCloseDays: 4, monthCloseEnabled: true, monthCloseAuto: true });
    expect((await t.api("PUT", "/api/settings/budget", { tossAnimation: false })).body).toEqual({ quickAssign: false, tossAnimation: false, monthCloseDays: 4, monthCloseEnabled: true, monthCloseAuto: true });
    expect((await t.api("PUT", "/api/settings/budget", { bogus: 1 })).status).toBe(400);
    const row = () => t.api("GET", "/api/transactions?year=2026&month=11").then((r) => r.body.find((x: any) => x.id === created.id));
    expect((await row()).suggestion).toBeNull();
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Trader%20Joe's&date=2026-11-04")).body.suggestion).toBeNull();
    const auto = (await t.api("POST", "/api/transactions", { date: "2026-11-04", merchant: "Trader Joe's", amountCents: 700, autoAssign: true })).body;
    expect(auto.autoAssigned).toBe(false);
    expect(auto.splits).toEqual([]);
    expect((await t.api("POST", `/api/transactions/${created.id}/accept-suggestion`)).status).toBe(400);

    await t.api("PUT", "/api/settings/budget", { quickAssign: true });
    expect((await row()).suggestion).toMatchObject({ itemName: "Groceries" });
  });

  it("income: suggests Other Income for the repeat deposit", async () => {
    const { octPay2, novPay2 } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-13", merchant: "ACH CREDIT HOMEDEPOT PAYROLL *4986 10/13", type: "income", amountCents: 332881, splits: [{ incomeItemId: octPay2.id, amountCents: 332881 }] });
    const nov = (await t.api("POST", "/api/transactions", { date: "2026-11-10", merchant: "ACH CREDIT HOMEDEPOT PAYROLL *4986 11/10", type: "income", amountCents: 332881 })).body;
    const row = (await t.api("GET", "/api/transactions?unassigned=true")).body.find((x: any) => x.id === nov.id);
    expect(row.suggestion).toMatchObject({ incomeItemId: novPay2.id, itemName: "Other Income", groupName: "Income" });
  });

  it("re-categorizing sticks: the most recent month wins, and type must match", async () => {
    const { oct, nov, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "Costco", amountCents: 100, splits: [{ lineItemId: find(oct, "Groceries").id, amountCents: 100 }] });
    await t.api("POST", "/api/transactions", { date: "2026-11-20", merchant: "Costco", amountCents: 100, splits: [{ lineItemId: find(nov, "Dining Out").id, amountCents: 100 }] });
    const res = (await t.api("GET", "/api/transactions/suggest?merchant=COSTCO%20%23443&date=2026-11-02")).body;
    expect(res.suggestion.itemName).toBe("Dining Out");
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Costco&date=2026-11-02&type=income")).body.suggestion).toBeNull();
  });

  it("two paychecks from the same employer: picks by day of month (and amount)", async () => {
    const { oct } = await twoMonths();
    const [p1, p2] = oct.income;
    await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "ACH CREDIT ACME PAYROLL *4986", type: "income", amountCents: 400000, splits: [{ incomeItemId: p1.id, amountCents: 400000 }] });
    await t.api("POST", "/api/transactions", { date: "2026-10-15", merchant: "ACH CREDIT ACME PAYROLL *4986", type: "income", amountCents: 400000, splits: [{ incomeItemId: p2.id, amountCents: 400000 }] });
    const on1 = (await t.api("GET", "/api/transactions/suggest?merchant=ACH%20CREDIT%20ACME%20PAYROLL%20*4986&date=2026-11-01&type=income")).body;
    const on14 = (await t.api("GET", "/api/transactions/suggest?merchant=ACH%20CREDIT%20ACME%20PAYROLL%20*4986&date=2026-11-14&type=income")).body;
    const on30 = (await t.api("GET", "/api/transactions/suggest?merchant=ACH%20CREDIT%20ACME%20PAYROLL%20*4986&date=2026-11-30&type=income")).body;
    expect([on1.suggestion.itemName, on14.suggestion.itemName, on30.suggestion.itemName]).toEqual(["Paycheck", "Other Income", "Paycheck"]);

    // After accepting November's first paycheck, the 15th still goes to Other Income
    const nov1 = (await t.api("POST", "/api/transactions", { date: "2026-11-01", merchant: "ACH CREDIT ACME PAYROLL *4986", type: "income", amountCents: 400000 })).body;
    const nov15 = (await t.api("POST", "/api/transactions", { date: "2026-11-15", merchant: "ACH CREDIT ACME PAYROLL *4986", type: "income", amountCents: 400000 })).body;
    await t.api("POST", `/api/transactions/${nov1.id}/accept-suggestion`);
    const res = await t.api("POST", `/api/transactions/${nov15.id}/accept-suggestion`);
    const nov = (await t.api("GET", "/api/months/2026/11")).body;
    expect(res.body.splits[0].incomeItemId).toBe(nov.income[1].id);
    expect(nov.income.map((i: { receivedCents: number }) => i.receivedCents)).toEqual([400000, 400000]);
  });

  it("no suggestion when the item doesn't exist in that month, or the merchant is new", async () => {
    const { oct, find } = await twoMonths();
    const g = (await t.api("POST", `/api/months/${oct.id}/groups`, { name: "One-off" })).body;
    const item = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Wedding gift" })).body;
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Crate & Barrel", amountCents: 100, splits: [{ lineItemId: item.id, amountCents: 100 }] });
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Crate%20%26%20Barrel&date=2026-11-05")).body.suggestion).toBeNull(); // copied before item existed
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Brand%20New%20Place&date=2026-11-05")).body.suggestion).toBeNull();
    expect(find(oct, "Groceries")).toBeTruthy();
  });

  it("falls back to the first two words when the bank adds or drops words", async () => {
    const { oct, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-12", merchant: "WinCo Foods - Weekly Groceries", amountCents: 100, splits: [{ lineItemId: find(oct, "Groceries").id, amountCents: 100 }] });
    expect((await t.api("GET", "/api/transactions/suggest?merchant=POS%20DEBIT%20WINCO%20FOODS%20%2377&date=2026-11-28")).body.suggestion.itemName).toBe("Groceries");
    // Different second word: no match
    expect((await t.api("GET", "/api/transactions/suggest?merchant=WinCo%20Pharmacy&date=2026-11-28")).body.suggestion).toBeNull();
  });

  it("falls back to the first word when that word alone is a merchant you've used", async () => {
    const { oct, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-12", merchant: "Shell", amountCents: 100, splits: [{ lineItemId: find(oct, "Fuel").id, amountCents: 100 }] });
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Shell%20Oil%205541&date=2026-11-20")).body.suggestion.itemName).toBe("Fuel");
    // Too short a word to trust, or only a longer merchant shares the word: no guess
    await t.api("POST", "/api/transactions", { date: "2026-10-12", merchant: "BP", amountCents: 100, splits: [{ lineItemId: find(oct, "Fuel").id, amountCents: 100 }] });
    expect((await t.api("GET", "/api/transactions/suggest?merchant=BP%20Amoco&date=2026-11-20")).body.suggestion).toBeNull();
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Shellfish%20Market&date=2026-11-20")).body.suggestion).toBeNull();
  });

  it("no two-word guess when merchants sharing those words went to different items", async () => {
    const { oct, find } = await twoMonths();
    const add = (merchant: string, item: string) => t.api("POST", "/api/transactions", { date: "2026-10-30", merchant, amountCents: 100, splits: [{ lineItemId: find(oct, item).id, amountCents: 100 }] });
    await add("Sinking Fund: Travel", "Groceries");
    await add("Sinking Fund: Home Repairs", "Spending Money");
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Sinking%20Fund%3A%20Holiday%20Gifts&date=2026-11-30")).body.suggestion).toBeNull();
    // Exact merchants still match
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Sinking%20Fund%3A%20Travel&date=2026-11-30")).body.suggestion.itemName).toBe("Groceries");
    // Different merchants under one prefix that all went to the same item are still a clear guess
    await add("WinCo Foods Weekly", "Groceries");
    await add("WinCo Foods Bulk", "Groceries");
    expect((await t.api("GET", "/api/transactions/suggest?merchant=WinCo%20Foods%20%2377&date=2026-11-28")).body.suggestion.itemName).toBe("Groceries");
  });

  it("a split teaches its biggest part", async () => {
    const { oct, find } = await twoMonths();
    await t.api("POST", "/api/transactions", {
      date: "2026-10-16", merchant: "Costco Wholesale", amountCents: 21560,
      splits: [{ lineItemId: find(oct, "Groceries").id, amountCents: 18000 }, { lineItemId: find(oct, "Spending Money").id, amountCents: 3560 }],
    });
    expect((await t.api("GET", "/api/transactions/suggest?merchant=Costco%20Wholesale&date=2026-11-16")).body.suggestion.itemName).toBe("Groceries");
  });
});

describe("accepting suggestions", () => {
  it("accept one, accept all, and fund history follows", async () => {
    const { oct, nov, find } = await twoMonths();
    const fund = (await t.api("POST", "/api/funds", { name: "Car" })).body;
    await t.api("PATCH", `/api/items/${find(nov, "Car Repairs").id}`, { sinkingFundId: fund.id, plannedCents: 10000 });
    for (const [m, item] of [["Jiffy Lube", "Car Repairs"], ["Shell", "Fuel"], ["WinCo", "Groceries"]] as const) {
      await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: m, amountCents: 100, splits: [{ lineItemId: find(oct, item).id, amountCents: 100 }] });
    }
    const ids: number[] = [];
    for (const m of ["Jiffy Lube", "Shell", "WinCo", "Unknown Store"]) {
      ids.push((await t.api("POST", "/api/transactions", { date: "2026-11-06", merchant: m, amountCents: 2500 })).body.id);
    }

    const one = await t.api("POST", `/api/transactions/${ids[0]}/accept-suggestion`);
    expect(one.status).toBe(200);
    expect(one.body.splits[0].lineItemId).toBe(find(nov, "Car Repairs").id);
    expect((await t.api("GET", "/api/funds?year=2026&month=11")).body[0]).toMatchObject({ contributedCents: 10000, spentCents: 2500 });

    const all = await t.api("POST", "/api/transactions/accept-suggestions", { ids });
    expect(all.body.assigned).toBe(2); // Shell + WinCo; Jiffy already done; Unknown has none
    const left = (await t.api("GET", "/api/transactions?unassigned=true")).body;
    expect(left.map((x: any) => x.merchant)).toEqual(["Unknown Store"]);
    expect(left[0].suggestion).toBeNull();
    expect((await t.api("POST", `/api/transactions/${ids[3]}/accept-suggestion`)).status).toBe(400);
  });

  it("autoAssign on create (for n8n / imports)", async () => {
    const { oct, nov, find } = await twoMonths();
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Netflix.com", amountCents: 1549, splits: [{ lineItemId: find(oct, "Streaming").id, amountCents: 1549 }] });
    const auto = (await t.api("POST", "/api/transactions", { date: "2026-11-05", merchant: "NETFLIX.COM", amountCents: 1549, autoAssign: true })).body;
    expect(auto.autoAssigned).toBe(true);
    expect(auto.splits[0].lineItemId).toBe(find(nov, "Streaming").id);
    const unknown = (await t.api("POST", "/api/transactions", { date: "2026-11-05", merchant: "Mystery", amountCents: 100, autoAssign: true })).body;
    expect(unknown.autoAssigned).toBe(false);
    expect(unknown.splits).toHaveLength(0);
  });
});

describe("merchant autocomplete", () => {
  it("lists past merchants matching the text, newest spelling first", async () => {
    await t.api("POST", "/api/transactions", { date: "2026-10-03", merchant: "Trader Joe's - Grocery Run", amountCents: 100 });
    await t.api("POST", "/api/transactions", { date: "2026-10-21", merchant: "Trader Joe's - Groceries", amountCents: 100 });
    await t.api("POST", "/api/transactions", { date: "2026-10-22", merchant: "Walgreens", amountCents: 100 });
    const res = (await t.api("GET", "/api/merchants?q=trader")).body;
    expect(res).toEqual(["Trader Joe's - Groceries", "Trader Joe's - Grocery Run"]);
    expect((await t.api("GET", "/api/merchants")).body[0]).toBe("Walgreens");
  });

  it("backfills keys for old transactions", async () => {
    await t.api("POST", "/api/transactions", { date: "2026-10-03", merchant: "Shell Oil #1", amountCents: 100 });
    await t.db.execute(sql`update transactions set merchant_key = null`);
    expect(await backfillMerchantKeys(t.db)).toBe(1);
    const r = await t.db.execute(sql`select merchant_key from transactions`);
    expect((r.rows[0] as { merchant_key: string }).merchant_key).toBe("shell oil");
  });
});
