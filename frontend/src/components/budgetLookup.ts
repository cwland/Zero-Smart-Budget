import type { Budget, Transaction } from "../api";

// Names for line items and income items, for labeling transactions
export function itemNames(budget: Budget) {
  const lines = new Map<number, string>();
  const income = new Map<number, string>();
  for (const g of budget.groups) for (const i of g.items) lines.set(i.id, i.name);
  for (const i of budget.income) income.set(i.id, i.name);
  return { lines, income };
}

// Came from the bank (Plaid): its account can't be changed
export const isBankImported = (t: Transaction | undefined) => !!t?.plaidTransactionId;

export const isUnassigned = (t: Transaction) => t.splits.every((s) => !s.lineItemId && !s.incomeItemId);

export function assignmentLabel(t: Transaction, names: ReturnType<typeof itemNames>) {
  const assigned = t.splits.filter((s) => s.lineItemId || s.incomeItemId);
  if (assigned.length === 0) return "Unassigned";
  if (assigned.length > 1) return `Split · ${assigned.length} items`;
  const s = assigned[0];
  return (s.lineItemId ? names.lines.get(s.lineItemId) : names.income.get(s.incomeItemId!)) ?? "Another month's item";
}
