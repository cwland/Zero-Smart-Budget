import { describe, expect, it } from "vitest";
import type { Transaction } from "../api";
import { isBankImported } from "./budgetLookup";

const tx = (extra: Partial<Transaction>): Transaction =>
  ({ id: 1, date: "2026-11-25", merchant: "ACH Credit", amountCents: 100, type: "income", note: null, splits: [], ...extra }) as Transaction;

describe("isBankImported: imported transactions keep their account", () => {
  it("is true for a transaction that came from the bank", () => {
    expect(isBankImported(tx({ plaidTransactionId: "bank-1" }))).toBe(true);
  });
  it("is false for one added by hand, even with an account picked", () => {
    expect(isBankImported(tx({ plaidTransactionId: null, plaidAccountId: "acc-1" }))).toBe(false);
  });
  it("is false for a new transaction", () => {
    expect(isBankImported(undefined)).toBe(false);
  });
});
