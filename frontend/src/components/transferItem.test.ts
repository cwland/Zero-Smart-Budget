import { describe, expect, it } from "vitest";
import type { BudgetLine } from "../api";
import { canBeTransfer } from "./transferItem";

const line = (extra: Partial<BudgetLine>): BudgetLine => ({
  id: 1, name: "Transfer", sortOrder: 0, plannedCents: 0, spentCents: 0, remainingCents: 0,
  sinkingFund: null, favorite: false, isTransfer: false, ...extra,
});

describe("canBeTransfer: fund and goal items can't be transfer items", () => {
  it("is true for a plain budget item", () => {
    expect(canBeTransfer(line({}))).toBe(true);
  });
  it("is false for an item linked to a sinking fund or goal", () => {
    expect(canBeTransfer(line({ sinkingFund: { id: 2, name: "Car", kind: "sinking", targetCents: null, balanceCents: 0, goalReached: false } }))).toBe(false);
  });
});
