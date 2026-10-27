import { and, asc, eq, inArray, lte, sql, sum as sqlSum } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  budgetMonths,
  categoryGroups,
  incomeItems,
  lineItems,
  sinkingFunds,
  transactionSplits,
} from "../db/schema.js";
import { budgetTotals, fundBalance, monthIndex, remaining, sum } from "./calc.js";

const toNumber = (v: string | number | null) => Number(v ?? 0);

// Sinking fund balances, counting money budgeted in months up to and including asOf
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
  const ids = funds.map((f) => f.id);

  const contributed = await db
    .select({ fundId: lineItems.sinkingFundId, total: sqlSum(lineItems.plannedCents) })
    .from(lineItems)
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
    .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
    .where(
      and(
        inArray(lineItems.sinkingFundId, ids),
        lte(sql`${budgetMonths.year} * 12 + (${budgetMonths.month} - 1)`, monthIndex(asOf.year, asOf.month))
      )
    )
    .groupBy(lineItems.sinkingFundId);

  const spent = await db
    .select({ fundId: lineItems.sinkingFundId, total: sqlSum(transactionSplits.amountCents) })
    .from(transactionSplits)
    .innerJoin(lineItems, eq(transactionSplits.lineItemId, lineItems.id))
    .where(inArray(lineItems.sinkingFundId, ids))
    .groupBy(lineItems.sinkingFundId);

  const contributedBy = new Map(contributed.map((r) => [r.fundId, toNumber(r.total)]));
  const spentBy = new Map(spent.map((r) => [r.fundId, toNumber(r.total)]));

  return funds.map((f) => {
    const contributedCents = contributedBy.get(f.id) ?? 0;
    const spentCents = spentBy.get(f.id) ?? 0;
    return {
      ...f,
      contributedCents,
      spentCents,
      balanceCents: fundBalance(f.startingBalanceCents, contributedCents, spentCents),
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
        .select({ id: transactionSplits.lineItemId, total: sqlSum(transactionSplits.amountCents) })
        .from(transactionSplits)
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
    receivedCents: receivedBy.get(i.id) ?? 0,
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
          sinkingFund: fund
            ? { id: fund.id, name: fund.name, targetCents: fund.targetCents, balanceCents: fund.balanceCents }
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

