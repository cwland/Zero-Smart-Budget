import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { autoCloseOldMonths } from "../src/lib/monthClose.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

// September 2026: $3,000 income (received), Rent 1,500, Groceries 600, Fun 200, Car fund 300 (linked)
async function september(opts: { groceries?: number; fun?: number } = {}) {
  const car = (await t.api("POST", "/api/funds", { name: "Car Repairs", startingBalanceCents: 10000 })).body;
  const sep = (await t.api("POST", "/api/months/2026/9", { mode: "blank" })).body;
  const pay = (await t.api("POST", `/api/months/${sep.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const g = (await t.api("POST", `/api/months/${sep.id}/groups`, { name: "Spending" })).body;
  const add = async (name: string, plannedCents: number, sinkingFundId?: number) =>
    (await t.api("POST", `/api/groups/${g.id}/items`, { name, plannedCents, sinkingFundId })).body;
  const rent = await add("Rent", 150000);
  const groceries = await add("Groceries", 60000);
  const fun = await add("Fun", 20000);
  const carItem = await add("Car", 30000, car.id);
  const spend = (date: string, merchant: string, amountCents: number, lineItemId: number) =>
    t.api("POST", "/api/transactions", { date, merchant, amountCents, splits: [{ lineItemId, amountCents }] });
  await t.api("POST", "/api/transactions", { date: "2026-09-01", merchant: "Acme", amountCents: 300000, type: "income", splits: [{ incomeItemId: pay.id, amountCents: 300000 }] });
  await spend("2026-09-02", "Landlord", 150000, rent.id);
  await spend("2026-09-10", "Kroger", opts.groceries ?? 52000, groceries.id); // $80 left
  await spend("2026-09-12", "Movies", opts.fun ?? 15000, fun.id); // $50 left
  await spend("2026-09-20", "Jiffy Lube", 40000, carItem.id); // fund item: overspent, but the fund handles it
  return { sep, pay, g, rent, groceries, fun, carItem, car, spend };
}
const month = async (y: number, m: number) => (await t.api("GET", `/api/months/${y}/${m}`)).body;
// Balances as of September (a copied October would add its own contribution)
const fund = async (id: number) => (await t.api("GET", "/api/funds?year=2026&month=9")).body.find((f: any) => f.id === id);

describe("Month Close", () => {
  it("previews money left, overspent items and the month total (fund items handle themselves)", async () => {
    const { sep } = await september({ fun: 26000 }); // Fun overspent by $60
    await t.api("POST", "/api/transactions", { date: "2026-09-25", merchant: "Mystery", amountCents: 999 });
    const p = (await t.api("GET", `/api/months/${sep.id}/close`)).body;
    expect(p.name).toBe("September 2026");
    expect(p.moneyLeft.map((i: any) => [i.name, i.remainingCents])).toEqual([["Groceries", 8000]]);
    expect(p.overspent.map((i: any) => [i.name, i.remainingCents])).toEqual([["Fun", -6000]]);
    expect(p.fundItems.map((i: any) => i.name)).toEqual(["Car"]);
    // 3000 - (1500 + 520 + 260) - 300 set aside = 420
    expect(p.totalCents).toBe(42000);
    expect(p.uncategorized).toBe(1);
  });

  it("puts the leftover in one fund, then the plan is read-only until reopened", async () => {
    const { sep, groceries, g, pay, car, spend } = await september();
    const r = (await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: car.id } })).body;
    // 3000 - 1500 - 520 - 150 - 300 = 530
    expect(r.result).toMatchObject({ totalCents: 53000, leftover: { to: "fund", fundId: car.id, amountCents: 53000, keptCents: 0 } });
    // 100 start + 300 set aside - 400 spent + 530 = 530
    expect((await fund(car.id)).balanceCents).toBe(53000);
    expect((await month(2026, 9)).close).toMatchObject({ closed: true, closedBy: "you", available: false, changedSinceClose: false });

    // Plan changes are refused
    for (const [m, p, b] of [
      ["PATCH", `/api/items/${groceries.id}`, { plannedCents: 1 }],
      ["POST", `/api/groups/${g.id}/items`, { name: "New" }],
      ["POST", `/api/months/${sep.id}/groups`, { name: "New" }],
      ["PATCH", `/api/income/${pay.id}`, { plannedCents: 1 }],
      ["DELETE", `/api/items/${groceries.id}`, undefined],
    ] as const) {
      const res = await t.api(m, p, b);
      expect(res.status, p).toBe(400);
      expect(res.body.error).toBe("September 2026 is closed. Reopen it to make changes.");
    }
    // Transactions still come in, and the month shows it changed since closing
    expect((await spend("2026-09-28", "Kroger", 1000, groceries.id)).status).toBe(201);
    expect((await month(2026, 9)).close.changedSinceClose).toBe(true);

    // Reopen changes nothing by itself, then edits work again
    await t.api("POST", `/api/months/${sep.id}/reopen`);
    expect((await fund(car.id)).balanceCents).toBe(53000);
    expect((await month(2026, 9)).close).toMatchObject({ closed: false, available: true });
    expect((await t.api("PATCH", `/api/items/${groceries.id}`, { plannedCents: 61000 })).status).toBe(200);

    // Closing again replaces the earlier close (no double counting): 530 - 10 more groceries = 520
    await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: car.id } });
    expect((await fund(car.id)).balanceCents).toBe(52000);
    const entries = (await t.api("GET", `/api/funds/${car.id}/entries`)).body.filter((e: any) => e.kind === "month_close");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amountCents: 52000, date: "2026-09-30", description: "Left over from September 2026", live: true });
    // ...and it can't be deleted from the fund's history
    expect((await t.api("DELETE", `/api/funds/${car.id}/entries/${entries[0].id}`)).status).toBe(400);
  });

  it("a goal only takes what it still needs; the rest stays in the month", async () => {
    const { sep } = await september();
    expect((await t.api("POST", "/api/funds", { name: "Emergency", kind: "goal" })).status).toBe(400); // needs a target
    const goal = (await t.api("POST", "/api/funds", { name: "Emergency", kind: "goal", targetCents: 100000, startingBalanceCents: 85000 })).body;
    const p = (await t.api("GET", `/api/months/${sep.id}/close`)).body;
    expect(p.funds.find((f: any) => f.id === goal.id)).toMatchObject({ kind: "goal", roomCents: 15000, goalReached: false });

    const r = (await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: goal.id } })).body;
    expect(r.result.leftover).toMatchObject({ to: "fund", amountCents: 15000, keptCents: 38000 });
    expect(await fund(goal.id)).toMatchObject({ balanceCents: 100000, goalReached: true });

    // A reached goal takes no more, by hand either
    expect((await t.api("POST", `/api/funds/${goal.id}/entries`, { date: "2026-10-01", amountCents: 100 })).body.error).toBe("Emergency has already reached its goal.");
    // Closing again (after reopening) works from the balance without this month's earlier close
    await t.api("POST", `/api/months/${sep.id}/reopen`);
    const again = (await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: goal.id } })).body;
    expect(again.result.leftover.amountCents).toBe(15000);
    // A different goal that's already full can't be picked
    const full = (await t.api("POST", "/api/funds", { name: "Full", kind: "goal", targetCents: 100, startingBalanceCents: 100 })).body;
    await t.api("POST", `/api/months/${sep.id}/reopen`);
    expect((await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: full.id } })).body.error).toBe(
      "Full has already reached its goal. Pick another fund or goal."
    );
    // Hand deposits are capped too
    const g2 = (await t.api("POST", "/api/funds", { name: "Bike", kind: "goal", targetCents: 5000 })).body;
    expect((await t.api("POST", `/api/funds/${g2.id}/entries`, { date: "2026-10-01", amountCents: 6000 })).body.error).toBe("Bike only needs $50.00 more to reach its goal.");
  });

  it("rolls over to next month as received income that only changes by closing again", async () => {
    const { sep } = await september();
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "copy" })).body;
    await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "rollover" } });
    let o = await month(2026, 10);
    const roll = o.income.find((i: any) => i.name === "Rollover from September");
    expect(roll).toMatchObject({ plannedCents: 53000, receivedCents: 53000, rolloverFrom: sep.id });
    expect(o.totals.leftToBudgetCents).toBe(40000 + 53000); // $530 more to budget in October
    // Can be renamed, but not changed or deleted
    expect((await t.api("PATCH", `/api/income/${roll.id}`, { plannedCents: 1 })).status).toBe(400);
    expect((await t.api("DELETE", `/api/income/${roll.id}`)).status).toBe(400);
    expect((await t.api("PATCH", `/api/income/${roll.id}`, { name: "From Sept" })).status).toBe(200);

    // Close again with a different choice: the rollover goes away
    await t.api("POST", `/api/months/${sep.id}/reopen`);
    await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "keep" } });
    o = await month(2026, 10);
    expect(o.income.some((i: any) => i.rolloverFrom)).toBe(false);
    expect(oct.id).toBe(o.id);
  });

  it("a rollover waits until next month is created, and isn't copied further", async () => {
    const { sep } = await september();
    await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "rollover" } });
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "copy" })).body;
    expect(oct.income.map((i: any) => [i.name, i.receivedCents])).toEqual([
      ["Paycheck", 0],
      ["Rollover from September", 53000],
    ]);
    const nov = (await t.api("POST", "/api/months/2026/11", { mode: "copy" })).body;
    expect(nov.income.map((i: any) => i.name)).toEqual(["Paycheck"]);
  });

  it("covers an overspend from one fund, up to what it has", async () => {
    const { sep, car } = await september({ fun: 90000 }); // Fun $700 over: total -220
    const p = (await t.api("GET", `/api/months/${sep.id}/close`)).body;
    expect(p.totalCents).toBe(-22000);
    // Car Repairs holds 100 + 300 - 400 = 0: nothing to cover with
    expect((await t.api("POST", `/api/months/${sep.id}/close`, { overspent: { to: "fund", fundId: car.id } })).body.error).toBe(
      "Car Repairs has no money to cover this. Pick another fund or goal."
    );
    const savings = (await t.api("POST", "/api/funds", { name: "Savings", startingBalanceCents: 15000 })).body;
    const r = (await t.api("POST", `/api/months/${sep.id}/close`, { overspent: { to: "fund", fundId: savings.id } })).body;
    expect(r.result.overspent).toMatchObject({ to: "fund", amountCents: 15000, uncoveredCents: 7000 });
    expect((await fund(savings.id)).balanceCents).toBe(0);
  });

  it("shows the button from 4 days before month end, and on past open months", async () => {
    await september();
    t.clock.date = new Date(2026, 8, 25, 12); // Sep 25
    expect((await month(2026, 9)).close.available).toBe(false);
    t.clock.date = new Date(2026, 8, 26, 12); // Sep 26 (4 days before the 30th)
    expect((await month(2026, 9)).close.available).toBe(true);
    t.clock.date = new Date(2026, 9, 3, 12); // October: September is past and open
    expect((await month(2026, 9)).close.available).toBe(true);
    // Settings > Budget: show it 10 days before instead
    t.clock.date = new Date(2026, 8, 20, 12); // Sep 20
    expect((await month(2026, 9)).close.available).toBe(false);
    expect((await t.api("PUT", "/api/settings/budget", { monthCloseDays: 10 })).body.monthCloseDays).toBe(10);
    expect((await month(2026, 9)).close.available).toBe(true);
    expect((await t.api("PUT", "/api/settings/budget", { monthCloseDays: 40 })).status).toBe(400);
  });

  it("closes months automatically on the 1st of the second month after, keeping the leftover", async () => {
    const { car } = await september();
    await t.api("POST", "/api/months/2026/10", { mode: "copy" });
    expect(await autoCloseOldMonths(t.db, new Date(2026, 9, 31, 23))).toBe(0); // Oct 31: nothing yet
    expect(await autoCloseOldMonths(t.db, new Date(2026, 10, 1, 1))).toBe(1); // Nov 1: September
    const s = await month(2026, 9);
    expect(s.close).toMatchObject({ closed: true, closedBy: "auto", result: { totalCents: 53000, leftover: { to: "keep", keptCents: 53000 } } });
    expect((await month(2026, 10)).close.closed).toBe(false);
    expect((await fund(car.id)).balanceCents).toBe(0); // nothing moved
    // It can still be reopened and closed by hand
    await t.api("POST", `/api/months/${s.id}/reopen`);
    await t.api("POST", `/api/months/${s.id}/close`, { leftover: { to: "fund", fundId: car.id } });
    expect((await fund(car.id)).balanceCents).toBe(53000);
  });

  it("backups keep closed months, goals and rollovers", async () => {
    const { sep } = await september();
    const goal = (await t.api("POST", "/api/funds", { name: "House", kind: "goal", targetCents: 1000000 })).body;
    await t.api("POST", "/api/months/2026/10", { mode: "copy" });
    await t.api("POST", `/api/months/${sep.id}/close`, { leftover: { to: "fund", fundId: goal.id } });
    const exported = (await t.api("GET", "/api/export")).body;
    const res = await t.api("POST", "/api/import?confirm=replace", exported);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await month(2026, 9)).close).toMatchObject({ closed: true, closedBy: "you", result: { leftover: { fundName: "House" } } });
    expect(await fund(goal.id)).toMatchObject({ kind: "goal", balanceCents: 53000 });
  });
});
