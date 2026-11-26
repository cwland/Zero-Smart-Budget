import type { BudgetLine } from "../api";

// Transfer items hold money moved between your own accounts (left out of reports, alerts and
// Month Wrap-Up). Fund and goal items keep counting toward their balance, so they can't be one.
export const canBeTransfer = (item: Pick<BudgetLine, "sinkingFund">) => !item.sinkingFund;
