import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

async function month(year: number, m: number) {
  const b = (await t.api("POST", `/api/months/${year}/${m}`, { mode: "blank" })).body;
  const inc = (await t.api("POST", `/api/months/${b.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const g = (await t.api("POST", `/api/months/${b.id}/groups`, { name: "Food" })).body;
  const groceries = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Groceries", plannedCents: 50000 })).body;
  const dining = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Dining Out", plannedCents: 20000 })).body;
  return { b, inc, groceries, dining };
}
const tx = (date: string, amountCents: number, splits: object[], type = "expense") =>
  t.api("POST", "/api/transactions", { date, merchant: "Shop", amountCents, type, splits });

describe("reports", () => {
  it("totals spending by item and income by source for each month in the range", async () => {
    const sep = await month(2026, 9);
    const oct = await month(2026, 10);
    await tx("2026-09-03", 12000, [{ lineItemId: sep.groceries.id, amountCents: 12000 }]);
    await tx("2026-09-04", 3000, [{ lineItemId: sep.groceries.id, amountCents: 3000 }], "income"); // refund
    await tx("2026-09-05", 5000, [{ lineItemId: sep.groceries.id, amountCents: 2000 }, { lineItemId: sep.dining.id, amountCents: 3000 }]); // split
    await tx("2026-10-02", 4000, [{ lineItemId: oct.dining.id, amountCents: 4000 }]);
    await tx("2026-09-01", 250000, [{ incomeItemId: sep.inc.id, amountCents: 250000 }], "income");
    await tx("2026-10-01", 260000, [{ incomeItemId: oct.inc.id, amountCents: 260000 }], "income");
    // Deleted transactions don't count
    const gone = (await tx("2026-10-09", 9999, [{ lineItemId: oct.groceries.id, amountCents: 9999 }])).body;
    await t.api("DELETE", `/api/transactions/${gone.id}`);

    const r = (await t.api("GET", "/api/reports?from=2026-08&to=2026-10")).body;
    expect(r.months).toEqual([{ year: 2026, month: 8 }, { year: 2026, month: 9 }, { year: 2026, month: 10 }]);
    expect(r.years).toEqual([2026]);
    expect(r.firstMonth).toEqual({ year: 2026, month: 9 });
    expect(r.spending).toEqual(
      expect.arrayContaining([
        { year: 2026, month: 9, group: "Food", item: "Groceries", cents: 11000 },
        { year: 2026, month: 9, group: "Food", item: "Dining Out", cents: 3000 },
        { year: 2026, month: 10, group: "Food", item: "Dining Out", cents: 4000 },
      ])
    );
    expect(r.spending).toHaveLength(3);
    expect(r.income).toEqual([
      { year: 2026, month: 9, source: "Paycheck", cents: 250000 },
      { year: 2026, month: 10, source: "Paycheck", cents: 260000 },
    ]);

    // Only months in the range
    const oct2 = (await t.api("GET", "/api/reports?from=2026-10&to=2026-10")).body;
    expect(oct2.spending).toEqual([{ year: 2026, month: 10, group: "Food", item: "Dining Out", cents: 4000 }]);
  });

  it("rejects bad ranges", async () => {
    expect((await t.api("GET", "/api/reports?from=2026-10&to=2026-09")).status).toBe(400);
    expect((await t.api("GET", "/api/reports?from=2026-13&to=2026-12")).status).toBe(400);
  });

  it("planned amounts, top merchants and fund balances", async () => {
    const fund = (await t.api("POST", "/api/funds", { name: "Car", startingBalanceCents: 10000 })).body;
    const sep = await month(2026, 9);
    await t.api("PATCH", `/api/items/${sep.dining.id}`, { sinkingFundId: fund.id });
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "copy" })).body;
    const octDining = oct.groups[0].items.find((i: { name: string }) => i.name === "Dining Out");
    const shop = (date: string, merchant: string, cents: number, lineItemId: number, type = "expense") =>
      t.api("POST", "/api/transactions", { date, merchant, amountCents: cents, type, splits: [{ lineItemId, amountCents: cents }] });
    await shop("2026-09-10", "Costco", 8000, sep.groceries.id);
    await shop("2026-10-03", "Costco", 6000, octDining.id);
    await shop("2026-10-04", "Costco", 1000, octDining.id, "income"); // a return
    await shop("2026-10-05", "Taco Bell", 1500, octDining.id);
    await t.api("POST", "/api/transactions", { date: "2026-10-06", merchant: "Transfer", amountCents: 99900, splits: [] }); // unassigned: not a merchant

    const r = (await t.api("GET", "/api/reports?from=2026-09&to=2026-10")).body;
    expect(r.planned).toEqual(
      expect.arrayContaining([
        { year: 2026, month: 9, group: "Food", item: "Groceries", cents: 50000 },
        { year: 2026, month: 10, group: "Food", item: "Dining Out", cents: 20000 },
      ])
    );
    expect(r.merchants).toEqual([
      { name: "Costco", visits: 2, cents: 13000, lastDate: "2026-10-04" },
      { name: "Taco Bell", visits: 1, cents: 1500, lastDate: "2026-10-05" },
    ]);
    // Car: 100 to start, +200 planned in Sep, +200 in Oct, -65 spent in Oct (60 - 10 return + 15)
    expect(r.funds).toEqual([{ id: fund.id, name: "Car", kind: "sinking", targetCents: null, balances: [30000, 43500] }]);
    expect(r.aiAvailable).toBe(false);
  });

  it("flags items that cost a lot more than usual in the last month", async () => {
    for (const [m, cents] of [[7, 10000], [8, 12000], [9, 11000], [10, 20000]]) {
      const b = await month(2026, m);
      await tx(`2026-${String(m).padStart(2, "0")}-05`, cents, [{ lineItemId: b.groceries.id, amountCents: cents }]);
      await tx(`2026-${String(m).padStart(2, "0")}-06`, 3000, [{ lineItemId: b.dining.id, amountCents: 3000 }]);
    }
    const r = (await t.api("GET", "/api/reports?from=2026-07&to=2026-10")).body;
    expect(r.unusual).toEqual([{ group: "Food", item: "Groceries", cents: 20000, usualCents: 11000, overCents: 9000, pct: 82 }]);
  });

  it("cash flow by day, by the transaction date", async () => {
    const oct = await month(2026, 10);
    await tx("2026-10-01", 250000, [{ incomeItemId: oct.inc.id, amountCents: 250000 }], "income");
    await tx("2026-10-01", 4000, [{ lineItemId: oct.dining.id, amountCents: 4000 }]);
    await tx("2026-10-15", 9000, []);
    const r = (await t.api("GET", "/api/reports/cashflow?month=2026-10")).body;
    expect(r.days).toEqual([
      { date: "2026-10-01", inCents: 250000, outCents: 4000, items: [{ merchant: "Shop", cents: 250000, type: "income" }, { merchant: "Shop", cents: 4000, type: "expense" }] },
      { date: "2026-10-15", inCents: 0, outCents: 9000, items: [{ merchant: "Shop", cents: 9000, type: "expense" }] },
    ]);
  });

  it("AI summary: needs AI on, and sends the period's numbers", async () => {
    const oct = await month(2026, 10);
    await tx("2026-10-02", 4000, [{ lineItemId: oct.dining.id, amountCents: 4000 }]);
    expect((await t.api("POST", "/api/reports/summary", { from: "2026-10", to: "2026-10" })).status).toBe(409);

    let sent = "";
    t.ai.respond = (_url: string, body: { messages: { content: string }[] }) => {
      sent = body.messages.map((m) => m.content).join("\n");
      return { status: 200, json: { choices: [{ message: { content: "- You spent $40 on Food." } }] } };
    };
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    const r = await t.api("POST", "/api/reports/summary", { from: "2026-10", to: "2026-10" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: "- You spent $40 on Food.", model: "tiny" });
    expect(sent).toContain("Spending by group: Food $40");
    expect(sent).toContain("October 2026: income $0, spent $40");
    expect((await t.api("GET", "/api/reports?from=2026-10&to=2026-10")).body.aiAvailable).toBe(true);

    t.ai.respond = () => ({ status: 500, json: { error: { message: "boom" } } });
    expect((await t.api("POST", "/api/reports/summary", { from: "2026-10", to: "2026-10" })).status).toBe(502);
  });
});

describe("transfer items in reports", () => {
  async function withTransfer() {
    const oct = await month(2026, 10);
    const g = (await t.api("GET", "/api/months/2026/10")).body.groups[0];
    const transfer = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Transfer", plannedCents: 0 })).body;
    await t.api("PATCH", `/api/items/${transfer.id}`, { isTransfer: true });
    return { ...oct, transfer };
  }
  const move = (date: string, merchant: string, cents: number, splits: object[], type = "expense") =>
    t.api("POST", "/api/transactions", { date, merchant, amountCents: cents, type, splits });

  it("are left out of spending, planned, merchants and cash flow", async () => {
    const oct = await withTransfer();
    await move("2026-10-03", "To savings", 50000, [{ lineItemId: oct.transfer.id, amountCents: 50000 }]);
    await move("2026-10-03", "From checking", 50000, [{ lineItemId: oct.transfer.id, amountCents: 50000 }], "income");
    await move("2026-10-04", "Grocer", 12000, [{ lineItemId: oct.groceries.id, amountCents: 12000 }]);

    const r = (await t.api("GET", "/api/reports?from=2026-10&to=2026-10")).body;
    expect(r.spending).toEqual([{ year: 2026, month: 10, group: "Food", item: "Groceries", cents: 12000 }]);
    expect(r.planned.map((p: { item: string }) => p.item)).not.toContain("Transfer");
    expect(r.merchants.map((m: { name: string }) => m.name)).toEqual(["Grocer"]);

    const cf = (await t.api("GET", "/api/reports/cashflow?month=2026-10")).body;
    expect(cf.days).toEqual([{ date: "2026-10-04", inCents: 0, outCents: 12000, items: [{ merchant: "Grocer", cents: 12000, type: "expense" }] }]);
  });

  it("a split transaction counts only its non-transfer part", async () => {
    const oct = await withTransfer();
    await move("2026-10-05", "Bank", 10000, [{ lineItemId: oct.transfer.id, amountCents: 6000 }, { lineItemId: oct.groceries.id, amountCents: 4000 }]);
    const r = (await t.api("GET", "/api/reports?from=2026-10&to=2026-10")).body;
    expect(r.spending).toEqual([{ year: 2026, month: 10, group: "Food", item: "Groceries", cents: 4000 }]);
    expect(r.merchants).toEqual([{ name: "Bank", visits: 1, cents: 4000, lastDate: "2026-10-05" }]);
    // It's still partly real spending, so it stays in the cash flow
    const cf = (await t.api("GET", "/api/reports/cashflow?month=2026-10")).body;
    expect(cf.days).toHaveLength(1);
  });

  it("unassigned transactions still count in cash flow", async () => {
    await withTransfer();
    await move("2026-10-07", "Unknown", 7000, []);
    const cf = (await t.api("GET", "/api/reports/cashflow?month=2026-10")).body;
    expect(cf.days).toEqual([{ date: "2026-10-07", inCents: 0, outCents: 7000, items: [{ merchant: "Unknown", cents: 7000, type: "expense" }] }]);
  });
});
