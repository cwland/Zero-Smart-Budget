import { and, asc, eq, inArray, lte, sql, sum as sqlSum } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  budgetMonths,
  categoryGroups,
  fundEntries,
  incomeItems,
  lineItems,
  sinkingFunds,
  transactions,
  transactionSplits,
} from "../db/schema.js";
import { budgetTotals, fundBalance, remaining, sum } from "./calc.js";

const toNumber = (v: string | number | null) => Number(v ?? 0);

// Sinking fund balances from their history, counting entries dated on or before the end of asOf's month
export async function loadFunds(
  db: Db,
  asOf: { year: number; month: number },
  opts: { fundIds?: number[]; includeArchived?: boolean } = {}
) {
  const { fundIds, includeArchived = true } = opts;
  if (fundIds && fundIds.length === 0) return [];

  const fundFilter = and(
    fundIds ? inArray(sinkingFunds.id, fundIds) : undefined,
    includeArchived ? undefined : eq(sinkingFunds.archived, false)
  );
  const funds = await db.select().from(sinkingFunds).where(fundFilter).orderBy(asc(sinkingFunds.id));
  if (!funds.length) return [];

  const lastDay = new Date(Date.UTC(asOf.year, asOf.month, 0)).getUTCDate();
  const asOfDate = `${asOf.year}-${String(asOf.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const totals = await db
    .select({ fundId: fundEntries.fundId, kind: fundEntries.kind, total: sqlSum(fundEntries.amountCents) })
    .from(fundEntries)
    .where(and(inArray(fundEntries.fundId, funds.map((f) => f.id)), lte(fundEntries.date, asOfDate)))
    .groupBy(fundEntries.fundId, fundEntries.kind);
  const get = (fundId: number, kind: string) => toNumber(totals.find((t) => t.fundId === fundId && t.kind === kind)?.total ?? 0);

  return funds.map((f) => {
    const contributedCents = get(f.id, "budgeted");
    const spentCents = -get(f.id, "spent");
    const adjustmentsCents = get(f.id, "adjustment");
    const monthCloseCents = get(f.id, "month_close"); // leftovers put in / overspends covered at Month Close
    const balanceCents = fundBalance(f.startingBalanceCents, contributedCents, spentCents) + adjustmentsCents + monthCloseCents;
    return {
      ...f,
      contributedCents,
      spentCents,
      adjustmentsCents,
      monthCloseCents,
      balanceCents,
      // Goals stop at their target
      goalReached: f.kind === "goal" && f.targetCents !== null && balanceCents >= f.targetCents,
    };
  });
}

// Full budget for one month with planned / spent / remaining everywhere
export async function loadBudget(db: Db, monthId: number) {
  const [month] = await db.select().from(budgetMonths).where(eq(budgetMonths.id, monthId));
  if (!month) return null;

  const income = await db
    .select()
    .from(incomeItems)
    .where(eq(incomeItems.monthId, monthId))
    .orderBy(asc(incomeItems.sortOrder), asc(incomeItems.id));
  const groups = await db
    .select()
    .from(categoryGroups)
    .where(eq(categoryGroups.monthId, monthId))
    .orderBy(asc(categoryGroups.sortOrder), asc(categoryGroups.id));
  const groupIds = groups.map((g) => g.id);
  const items = groupIds.length
    ? await db
        .select()
        .from(lineItems)
        .where(inArray(lineItems.groupId, groupIds))
        .orderBy(asc(lineItems.sortOrder), asc(lineItems.id))
    : [];

  const itemIds = items.map((i) => i.id);
  const spentRows = itemIds.length
    ? await db
        // Net spending: expenses add, income on a budget item (refund / money back) subtracts
        .select({
          id: transactionSplits.lineItemId,
          total: sql<string>`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end)`,
        })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
        .where(inArray(transactionSplits.lineItemId, itemIds))
        .groupBy(transactionSplits.lineItemId)
    : [];
  const incomeIds = income.map((i) => i.id);
  const receivedRows = incomeIds.length
    ? await db
        .select({ id: transactionSplits.incomeItemId, total: sqlSum(transactionSplits.amountCents) })
        .from(transactionSplits)
        .where(inArray(transactionSplits.incomeItemId, incomeIds))
        .groupBy(transactionSplits.incomeItemId)
    : [];
  const spentBy = new Map(spentRows.map((r) => [r.id, toNumber(r.total)]));
  const receivedBy = new Map(receivedRows.map((r) => [r.id, toNumber(r.total)]));

  const fundIds = [...new Set(items.map((i) => i.sinkingFundId).filter((id): id is number => id !== null))];
  const funds = await loadFunds(db, month, { fundIds });
  const fundsById = new Map(funds.map((f) => [f.id, f]));

  const incomeOut = income.map((i) => ({
    id: i.id,
    name: i.name,
    sortOrder: i.sortOrder,
    plannedCents: i.plannedCents,
    // A rollover from last month's Month Close is money you already have
    receivedCents: i.rolloverFromMonthId ? i.plannedCents + (receivedBy.get(i.id) ?? 0) : receivedBy.get(i.id) ?? 0,
    rolloverFrom: i.rolloverFromMonthId,
  }));

  const groupsOut = groups.map((g) => {
    const lines = items
      .filter((i) => i.groupId === g.id)
      .map((i) => {
        const spentCents = spentBy.get(i.id) ?? 0;
        const fund = i.sinkingFundId ? fundsById.get(i.sinkingFundId) : undefined;
        return {
          id: i.id,
          name: i.name,
          sortOrder: i.sortOrder,
          plannedCents: i.plannedCents,
          spentCents,
          remainingCents: remaining({ plannedCents: i.plannedCents, spentCents }),
          favorite: i.favorite,
          isTransfer: i.isTransfer,
          sinkingFund: fund
            ? { id: fund.id, name: fund.name, kind: fund.kind, targetCents: fund.targetCents, balanceCents: fund.balanceCents, goalReached: fund.goalReached }
            : null,
        };
      });
    const plannedCents = sum(lines, (l) => l.plannedCents);
    const spentCents = sum(lines, (l) => l.spentCents);
    return {
      id: g.id,
      name: g.name,
      sortOrder: g.sortOrder,
      plannedCents,
      spentCents,
      remainingCents: plannedCents - spentCents,
      items: lines,
    };
  });

  return {
    id: month.id,
    year: month.year,
    month: month.month,
    income: incomeOut,
    groups: groupsOut,
    totals: budgetTotals(incomeOut, groupsOut.flatMap((g) => g.items)),
  };
}

export async function nextSortOrder(
  db: Db,
  table: typeof incomeItems | typeof categoryGroups | typeof lineItems,
  where: ReturnType<typeof eq>
) {
  const [row] = await db
    .select({ max: sql<number | null>`max(${table.sortOrder})` })
    .from(table)
    .where(where);
  return row.max === null ? 0 : Number(row.max) + 1;
}

