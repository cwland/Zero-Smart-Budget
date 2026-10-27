// Pure budget math. All values are integer cents.

export const monthIndex = (year: number, month: number) => year * 12 + (month - 1);

export function previousMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function nextMonth(year: number, month: number) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

// First and last day of a month as YYYY-MM-DD
export function monthDateRange(year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export interface LineCalc {
  plannedCents: number;
  spentCents: number;
}

export const remaining = (l: LineCalc) => l.plannedCents - l.spentCents;

export function sum<T>(rows: T[], pick: (r: T) => number) {
  return rows.reduce((total, r) => total + pick(r), 0);
}

// Zero-based budget: every planned dollar of income gets a job.
// leftToBudget = planned income - everything planned in groups. Goal is 0.
export function budgetTotals(
  income: { plannedCents: number; receivedCents: number }[],
  lines: LineCalc[]
) {
  const incomePlannedCents = sum(income, (i) => i.plannedCents);
  const incomeReceivedCents = sum(income, (i) => i.receivedCents);
  const plannedCents = sum(lines, (l) => l.plannedCents);
  const spentCents = sum(lines, (l) => l.spentCents);
  return {
    incomePlannedCents,
    incomeReceivedCents,
    plannedCents,
    spentCents,
    remainingCents: plannedCents - spentCents,
    leftToBudgetCents: incomePlannedCents - plannedCents,
  };
}

// Sinking fund balance = starting balance + money budgeted into it - money spent from it
export function fundBalance(startingBalanceCents: number, contributedCents: number, spentCents: number) {
  return startingBalanceCents + contributedCents - spentCents;
}
