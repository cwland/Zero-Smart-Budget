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
});
