import { describe, expect, it } from "vitest";
import { budgetTotals, fundBalance, monthDateRange, nextMonth, previousMonth } from "../src/lib/calc.js";

describe("budget math", () => {
  it("still to plan is planned income minus planned expenses", () => {
    const t = budgetTotals(
      [{ plannedCents: 300000, receivedCents: 150000 }, { plannedCents: 50000, receivedCents: 0 }],
      [{ plannedCents: 120000, spentCents: 120000 }, { plannedCents: 60000, spentCents: 4550 }]
    );
    expect(t.incomePlannedCents).toBe(350000);
    expect(t.incomeReceivedCents).toBe(150000);
    expect(t.plannedCents).toBe(180000);
    expect(t.spentCents).toBe(124550);
    expect(t.remainingCents).toBe(55450);
    expect(t.leftToBudgetCents).toBe(170000);
  });

  it("goes negative when over-budgeted", () => {
    const t = budgetTotals([{ plannedCents: 1000, receivedCents: 0 }], [{ plannedCents: 1500, spentCents: 0 }]);
    expect(t.leftToBudgetCents).toBe(-500);
  });

  it("sinking fund balance", () => {
    expect(fundBalance(10000, 30000, 5000)).toBe(35000);
  });

  it("month helpers handle year boundaries and leap years", () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(nextMonth(2026, 12)).toEqual({ year: 2027, month: 1 });
    expect(monthDateRange(2028, 2)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthDateRange(2026, 10)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});
