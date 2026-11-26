import { describe, expect, it } from "vitest";
import type { Budget } from "../api";
import { moveTarget } from "./monthSwitch";

// A minimal budget month: income items and groups of budget items, by name
function month(
  year: number,
  m: number,
  income: [number, string][],
  groups: [string, [number, string][]][],
): Budget {
  const totals = { incomePlannedCents: 0, incomeReceivedCents: 0, plannedCents: 0, spentCents: 0, remainingCents: 0, leftToBudgetCents: 0 };
  return {
    exists: true,
    id: year * 100 + m,
    year,
    month: m,
    income: income.map(([id, name], i) => ({ id, name, sortOrder: i, plannedCents: 0, receivedCents: 0 })),
    groups: groups.map(([name, items], gi) => ({
      id: gi + 1,
      name,
      sortOrder: gi,
      plannedCents: 0,
      spentCents: 0,
      remainingCents: 0,
      items: items.map(([id, itemName], ii) => ({
        id,
        name: itemName,
        sortOrder: ii,
        plannedCents: 0,
        spentCents: 0,
        remainingCents: 0,
        sinkingFund: null,
        favorite: false,
      })),
    })),
    totals,
    close: { closed: false, closedAt: null, closedBy: null, available: false, result: null, changedSinceClose: false },
  } as Budget;
}

const nov = month(2026, 11, [[1, "Paycheck"], [2, "Side gig"]], [
  ["Food", [[10, "Groceries"], [11, "Misc"]]],
  ["Home", [[12, "Rent"], [13, "Misc"]]],
]);
const dec = month(2026, 12, [[21, "Paycheck"]], [
  ["Food", [[30, "Groceries"], [31, "Misc"]]],
  ["House", [[32, "Rent"], [33, "Misc"]]],
]);

describe("moveTarget: keep a transaction's item when its date moves to another month", () => {
  it("moves an income item to the income item with the same name", () => {
    expect(moveTarget("i:1", nov, dec)).toBe("i:21");
  });

  it("moves a budget item to the same group and item name", () => {
    expect(moveTarget("l:10", nov, dec)).toBe("l:30");
  });

  it("finds a budget item by name alone when its group was renamed and the name is unique", () => {
    expect(moveTarget("l:12", nov, dec)).toBe("l:32"); // Home › Rent -> House › Rent
  });

  it("leaves it unassigned when the name is in several groups and the group doesn't match", () => {
    expect(moveTarget("l:13", nov, dec)).toBe(""); // Home › Misc: Food › Misc or House › Misc?
  });

  it("leaves it unassigned when the other month has no item with that name", () => {
    expect(moveTarget("i:2", nov, dec)).toBe(""); // no "Side gig" in December
  });

  it("leaves an empty pick empty", () => {
    expect(moveTarget("", nov, dec)).toBe("");
  });
});
