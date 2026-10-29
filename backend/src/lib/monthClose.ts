import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, fundEntries, incomeItems, transactions, transactionSplits, type MonthCloseResult } from "../db/schema.js";
import { loadBudget, loadFunds, nextSortOrder } from "./budget.js";
import { monthDateRange, monthIndex, nextMonth } from "./calc.js";
import { badRequest, notFound } from "./errors.js";
import { getBudgetPrefs } from "./prefs.js";

// Month Close (shown to users as "Month Wrap-Up"): at the end of a month, see which items have money left and
// which are overspent, then either put the leftover in ONE fund or goal (or roll it over to next
// month), or cover the overspend from ONE fund or goal. Optional: months close themselves on the
// 1st of the second month after (September closes November 1), keeping any leftover in the month.
//
// Items linked to a sinking fund aren't part of it: their leftover (or overspend) already stays
// in the fund. So the month's result is:
//   income received - spending on regular items - money set aside on fund items

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: { year: number; month: number }) => `${MONTH_NAMES[m.month - 1]} ${m.year}`;

type Budget = NonNullable<Awaited<ReturnType<typeof loadBudget>>>;

// The month's result from a loaded budget (see above)
export function closeTotal(b: Budget) {
  const items = b.groups.flatMap((g) => g.items);
  const regularSpent = items.filter((i) => !i.sinkingFund).reduce((n, i) => n + i.spentCents, 0);
  const setAside = items.filter((i) => i.sinkingFund).reduce((n, i) => n + i.plannedCents, 0);
  return b.totals.incomeReceivedCents - regularSpent - setAside;
}

// When the Month Close banner shows: from 4 days before the month's last day, and on any past
// month that's still open
export function closeAvailable(m: { year: number; month: number }, now: Date, daysBefore = 4) {
  const cur = monthIndex(now.getFullYear(), now.getMonth() + 1);
  const idx = monthIndex(m.year, m.month);
  if (idx < cur) return true;
  if (idx > cur) return false;
  const lastDay = new Date(m.year, m.month, 0).getDate();
  return now.getDate() >= lastDay - daysBefore;
}

// Close state for the budget screen
export function closeState(row: typeof budgetMonths.$inferSelect, b: Budget, now: Date, daysBefore = 4, enabled = true) {
  const total = closeTotal(b);
  return {
    closed: !!row.closedAt,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    available: enabled && !row.closedAt && closeAvailable(row, now, daysBefore),
    result: row.closeResult,
    // A transaction came in (or changed) after closing, so the result is out of date
    changedSinceClose: !!row.closedAt && !!row.closeResult && row.closeResult.totalCents !== total,
  };
}

// Everything the Month Close screen shows
export async function closePreview(db: Db, monthId: number) {
  const [row] = await db.select().from(budgetMonths).where(eq(budgetMonths.id, monthId));
  if (!row) throw notFound("Month");
  const b = (await loadBudget(db, monthId))!;
  const items = b.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name })));
  const regular = items.filter((i) => !i.sinkingFund);
  const { from, to } = monthDateRange(row.year, row.month);

  // Uncategorized transactions in this month (track everything before closing)
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        sql`${transactions.date} between ${from} and ${to}`,
        isNull(transactions.deletedAt),
        eq(transactions.pending, false),
        sql`not exists (select 1 from ${transactionSplits} s where s.transaction_id = ${transactions.id} and (s.line_item_id is not null or s.income_item_id is not null))`
      )
    );

  const totalCents = closeTotal(b);
  const funds = (await loadFunds(db, row, { includeArchived: false })).map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    targetCents: f.targetCents,
    balanceCents: f.balanceCents,
    goalReached: f.goalReached,
    // Most a goal can take before it hits its target
    roomCents: f.kind === "goal" && f.targetCents !== null ? Math.max(0, f.targetCents - f.balanceCents) : null,
  }));
  const next = nextMonth(row.year, row.month);
  const [nextRow] = await db
    .select({ id: budgetMonths.id })
    .from(budgetMonths)
    .where(and(eq(budgetMonths.year, next.year), eq(budgetMonths.month, next.month)));

  return {
    id: row.id,
    year: row.year,
    month: row.month,
    name: monthName(row),
    nextName: monthName(next),
    nextExists: !!nextRow,
    closed: !!row.closedAt,
    closedBy: row.closedBy,
    result: row.closeResult,
    uncategorized: n,
    moneyLeft: regular.filter((i) => i.remainingCents > 0).map((i) => ({ id: i.id, name: i.name, group: i.group, plannedCents: i.plannedCents, spentCents: i.spentCents, remainingCents: i.remainingCents })),
    overspent: regular.filter((i) => i.remainingCents < 0).map((i) => ({ id: i.id, name: i.name, group: i.group, plannedCents: i.plannedCents, spentCents: i.spentCents, remainingCents: i.remainingCents })),
    // Fund items handle themselves (shown for information)
    fundItems: items.filter((i) => i.sinkingFund).map((i) => ({ id: i.id, name: i.name, fundName: i.sinkingFund!.name, remainingCents: i.remainingCents })),
    income: { plannedCents: b.totals.incomePlannedCents, receivedCents: b.totals.incomeReceivedCents },
    leftToBudgetCents: b.totals.leftToBudgetCents,
    totalCents,
    funds,
  };
}

export type CloseChoice =
  | { leftover?: { to: "fund"; fundId: number } | { to: "rollover" } | { to: "keep" }; overspent?: { to: "fund"; fundId: number } | { to: "keep" } };

// Undo what an earlier close did (closing again replaces it)
async function clearCloseEffects(db: Db, monthId: number) {
  await db.delete(fundEntries).where(and(eq(fundEntries.kind, "month_close"), eq(fundEntries.closeMonthId, monthId)));
  await db.delete(incomeItems).where(eq(incomeItems.rolloverFromMonthId, monthId));
}

// Put a month's rollover into next month as an income item (if next month exists yet)
export async function applyRollover(db: Db, fromMonth: typeof budgetMonths.$inferSelect) {
  const r = fromMonth.closeResult?.leftover;
  if (r?.to !== "rollover" || r.amountCents <= 0) return;
  const next = nextMonth(fromMonth.year, fromMonth.month);
  const [nextRow] = await db
    .select({ id: budgetMonths.id })
    .from(budgetMonths)
    .where(and(eq(budgetMonths.year, next.year), eq(budgetMonths.month, next.month)));
  if (!nextRow) return; // added when that month is created
  const [already] = await db.select({ id: incomeItems.id }).from(incomeItems).where(eq(incomeItems.rolloverFromMonthId, fromMonth.id));
  if (already) {
    await db.update(incomeItems).set({ plannedCents: r.amountCents }).where(eq(incomeItems.id, already.id));
    return;
  }
  await db.insert(incomeItems).values({
    monthId: nextRow.id,
    name: `Rollover from ${MONTH_NAMES[fromMonth.month - 1]}`,
    plannedCents: r.amountCents,
    sortOrder: await nextSortOrder(db, incomeItems, eq(incomeItems.monthId, nextRow.id)),
    rolloverFromMonthId: fromMonth.id,
  });
}

// Close a month (or close it again after reopening)
export async function closeMonth(db: Db, monthId: number, choice: CloseChoice) {
  const preview = await closePreview(db, monthId);
  const [row] = await db.select().from(budgetMonths).where(eq(budgetMonths.id, monthId));
  const total = preview.totalCents;
  const lastDay = monthDateRange(row.year, row.month).to;
  const fundById = (id: number) => {
    const f = preview.funds.find((x) => x.id === id);
    if (!f) throw badRequest("Pick a fund or goal");
    return f;
  };
  // Funds as they'd be without this month's earlier close (closing again replaces it)
  const earlier = new Map<number, number>();
  const prevEntries = await db
    .select({ fundId: fundEntries.fundId, amountCents: fundEntries.amountCents })
    .from(fundEntries)
    .where(and(eq(fundEntries.kind, "month_close"), eq(fundEntries.closeMonthId, monthId)));
  for (const e of prevEntries) earlier.set(e.fundId, (earlier.get(e.fundId) ?? 0) + e.amountCents);
  const balanceOf = (f: { id: number; balanceCents: number }) => f.balanceCents - (earlier.get(f.id) ?? 0);

  const result: MonthCloseResult = { totalCents: total };
  const entries: (typeof fundEntries.$inferInsert)[] = [];

  if (total > 0) {
    const c = choice.leftover ?? { to: "keep" };
    if (c.to === "fund") {
      const f = fundById(c.fundId);
      // A goal only takes what it still needs; the rest stays in the month
      const room = f.kind === "goal" && f.targetCents !== null ? Math.max(0, f.targetCents - balanceOf(f)) : Infinity;
      const amount = Math.min(total, room);
      if (amount <= 0) throw badRequest(`${f.name} has already reached its goal. Pick another fund or goal.`);
      entries.push({ fundId: f.id, kind: "month_close", date: lastDay, amountCents: amount, description: `Left over from ${preview.name}`, closeMonthId: monthId });
      result.leftover = { to: "fund", fundId: f.id, fundName: f.name, amountCents: amount, keptCents: total - amount };
    } else if (c.to === "rollover") {
      result.leftover = { to: "rollover", amountCents: total, keptCents: 0 };
    } else {
      result.leftover = { to: "keep", amountCents: 0, keptCents: total };
    }
  } else if (total < 0) {
    const short = -total;
    const c = choice.overspent ?? { to: "keep" };
    if (c.to === "fund") {
      const f = fundById(c.fundId);
      // Take what the fund has, up to the overspend
      const amount = Math.min(short, Math.max(0, balanceOf(f)));
      if (amount <= 0) throw badRequest(`${f.name} has no money to cover this. Pick another fund or goal.`);
      entries.push({ fundId: f.id, kind: "month_close", date: lastDay, amountCents: -amount, description: `Covered overspending in ${preview.name}`, closeMonthId: monthId });
      result.overspent = { to: "fund", fundId: f.id, fundName: f.name, amountCents: amount, uncoveredCents: short - amount };
    } else {
      result.overspent = { to: "keep", amountCents: 0, uncoveredCents: short };
    }
  }

  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await clearCloseEffects(t, monthId);
    if (entries.length) await tx.insert(fundEntries).values(entries);
    const [closed] = await tx
      .update(budgetMonths)
      .set({ closedAt: new Date(), closedBy: "you", closeResult: result })
      .where(eq(budgetMonths.id, monthId))
      .returning();
    await applyRollover(t, closed);
  });
  return result;
}

// Reopen: changes nothing by itself; the plan can be edited again until it's closed again
export async function reopenMonth(db: Db, monthId: number) {
  const [row] = await db.update(budgetMonths).set({ closedAt: null, closedBy: null }).where(eq(budgetMonths.id, monthId)).returning();
  if (!row) throw notFound("Month");
}

// Close months that are two or more months old and still open. Their leftover stays in the month.
export async function autoCloseOldMonths(db: Db, now = new Date()) {
  const prefs = await getBudgetPrefs(db);
  if (!prefs.monthCloseEnabled || !prefs.monthCloseAuto) return 0; // Settings > Budget: Month Close off, or "leave it open"
  const cutoff = monthIndex(now.getFullYear(), now.getMonth() + 1) - 2;
  const open = await db
    .select()
    .from(budgetMonths)
    .where(and(isNull(budgetMonths.closedAt), sql`${budgetMonths.year} * 12 + (${budgetMonths.month} - 1) <= ${cutoff}`));
  for (const m of open) {
    const b = (await loadBudget(db, m.id))!;
    const total = closeTotal(b);
    // Reopened and never closed again: keep what that close did; otherwise nothing moves
    const result: MonthCloseResult = m.closeResult ?? {
      totalCents: total,
      ...(total > 0 ? { leftover: { to: "keep" as const, amountCents: 0, keptCents: total } } : {}),
      ...(total < 0 ? { overspent: { to: "keep" as const, amountCents: 0, uncoveredCents: -total } } : {}),
    };
    await db.update(budgetMonths).set({ closedAt: now, closedBy: "auto", closeResult: result }).where(eq(budgetMonths.id, m.id));
  }
  return open.length;
}

// Refuse plan changes in a closed month
export async function assertOpen(db: Db, monthId: number) {
  const [row] = await db.select({ year: budgetMonths.year, month: budgetMonths.month, closedAt: budgetMonths.closedAt }).from(budgetMonths).where(eq(budgetMonths.id, monthId));
  if (row?.closedAt) throw badRequest(`${monthName(row)} is closed. Reopen it to make changes.`);
}

