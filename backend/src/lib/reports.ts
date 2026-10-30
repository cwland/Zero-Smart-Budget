import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, fundEntries, incomeItems, lineItems, sinkingFunds, transactions, transactionSplits } from "../db/schema.js";
import { monthDateRange } from "./calc.js";

// Report data for a range of budget months (Reports page, CSV export and the AI summary).
// Money counts in the budget month of the item it's assigned to (like the budget page does),
// and groups, items and income sources are matched across months by name.

export interface YM {
  year: number;
  month: number;
}
export const ymIndex = ({ year, month }: YM) => year * 12 + (month - 1);
const fromIndex = (i: number): YM => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
const monthExpr = sql<number>`${budgetMonths.year} * 12 + ${budgetMonths.month} - 1`;

export async function reportData(db: Db, from: YM, to: YM) {
  const a = ymIndex(from);
  const b = ymIndex(to);
  const inRange = sql`${monthExpr} between ${a} and ${b}`;
  const months: YM[] = [];
  for (let i = a; i <= b; i++) months.push(fromIndex(i));

  // Net spending per item per month: expenses add, refunds (income on a budget item) subtract
  const spendRows = await db
    .select({
      year: budgetMonths.year,
      month: budgetMonths.month,
      group: categoryGroups.name,
      item: lineItems.name,
      cents: sql<string>`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end)`,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .innerJoin(lineItems, eq(transactionSplits.lineItemId, lineItems.id))
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
    .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
    .where(and(inRange, isNull(transactions.deletedAt)))
    .groupBy(budgetMonths.year, budgetMonths.month, categoryGroups.name, lineItems.name)
    .orderBy(asc(budgetMonths.year), asc(budgetMonths.month));

  // Planned per item per month (for Planned vs. Spent)
  const plannedRows = await db
    .select({
      year: budgetMonths.year,
      month: budgetMonths.month,
      group: categoryGroups.name,
      item: lineItems.name,
      cents: sql<string>`sum(${lineItems.plannedCents})`,
    })
    .from(lineItems)
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
    .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
    .where(inRange)
    .groupBy(budgetMonths.year, budgetMonths.month, categoryGroups.name, lineItems.name)
    .orderBy(asc(budgetMonths.year), asc(budgetMonths.month));

  // Money received per income source per month (a Month Close rollover isn't new income)
  const incomeRows = await db
    .select({
      year: budgetMonths.year,
      month: budgetMonths.month,
      source: incomeItems.name,
      cents: sql<string>`sum(${transactionSplits.amountCents})`,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .innerJoin(incomeItems, eq(transactionSplits.incomeItemId, incomeItems.id))
    .innerJoin(budgetMonths, eq(incomeItems.monthId, budgetMonths.id))
    .where(and(inRange, isNull(transactions.deletedAt), isNull(incomeItems.rolloverFromMonthId)))
    .groupBy(budgetMonths.year, budgetMonths.month, incomeItems.name)
    .orderBy(asc(budgetMonths.year), asc(budgetMonths.month));

  // Top merchants by the date of the purchase, counting only what's assigned to budget items
  const first = monthDateRange(from.year, from.month).from;
  const last = monthDateRange(to.year, to.month).to;
  const merchantKey = sql<string>`coalesce(${transactions.merchantKey}, lower(${transactions.merchant}))`;
  const merchantRows = await db
    .select({
      key: merchantKey,
      name: sql<string>`(array_agg(${transactions.merchant} order by ${transactions.date} desc))[1]`,
      visits: sql<string>`count(distinct ${transactions.id}) filter (where ${transactions.type} = 'expense')`,
      cents: sql<string>`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end)`,
      lastDate: sql<string>`max(${transactions.date})`,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .where(and(sql`${transactionSplits.lineItemId} is not null`, isNull(transactions.deletedAt), sql`${transactions.date} between ${first} and ${last}`))
    .groupBy(merchantKey)
    .having(sql`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end) > 0`)
    .orderBy(sql`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end) desc`)
    .limit(25);

  // Fund and goal balances at the end of each month
  const funds = await db.select().from(sinkingFunds).where(eq(sinkingFunds.archived, false)).orderBy(asc(sinkingFunds.id));
  const entryRows = funds.length
    ? await db
        .select({
          fundId: fundEntries.fundId,
          idx: sql<string>`extract(year from ${fundEntries.date}) * 12 + extract(month from ${fundEntries.date}) - 1`,
          cents: sql<string>`sum(${fundEntries.amountCents})`,
        })
        .from(fundEntries)
        .where(sql`${fundEntries.date} <= ${last}`)
        .groupBy(fundEntries.fundId, sql`2`)
    : [];
  const fundsOut = funds.map((f) => {
    const mine = entryRows.filter((e) => e.fundId === f.id).map((e) => ({ idx: Number(e.idx), cents: Number(e.cents) }));
    let balance = f.startingBalanceCents + mine.filter((e) => e.idx < a).reduce((t, e) => t + e.cents, 0);
    const balances = months.map((m) => {
      balance += mine.filter((e) => e.idx === ymIndex(m)).reduce((t, e) => t + e.cents, 0);
      return balance;
    });
    return { id: f.id, name: f.name, kind: f.kind, targetCents: f.targetCents, balances };
  });

  // Years with a budget, for the earlier-year choices in the date filter
  const years = (await db.selectDistinct({ year: budgetMonths.year }).from(budgetMonths).orderBy(asc(budgetMonths.year))).map((r) => r.year);

  const num = <T extends { cents: string }>(rows: T[]) => rows.map((r) => ({ ...r, cents: Number(r.cents) }));
  return {
    months,
    years,
    spending: num(spendRows),
    planned: num(plannedRows),
    income: num(incomeRows),
    merchants: merchantRows.map((m) => ({ name: m.name, visits: Number(m.visits), cents: Number(m.cents), lastDate: m.lastDate })),
    funds: fundsOut,
  };
}
export type ReportData = Awaited<ReturnType<typeof reportData>>;

// Items that cost a lot more than usual in the last month of the range: at least 25% and $20
// above their average over the earlier months that had spending (needs two of those).
export function unusualSpending(r: ReportData) {
  const last = r.months[r.months.length - 1];
  const byItem = new Map<string, { group: string; item: string; now: number; before: number[] }>();
  for (const s of r.spending) {
    const k = `${s.group}\u0000${s.item}`;
    const row = byItem.get(k) ?? { group: s.group, item: s.item, now: 0, before: [] };
    if (s.year === last.year && s.month === last.month) row.now += s.cents;
    else if (s.cents > 0) row.before.push(s.cents);
    byItem.set(k, row);
  }
  return [...byItem.values()]
    .filter((r) => r.before.length >= 2)
    .map((r) => {
      const usual = Math.round(r.before.reduce((t, v) => t + v, 0) / r.before.length);
      return { group: r.group, item: r.item, cents: r.now, usualCents: usual, overCents: r.now - usual, pct: usual ? Math.round(((r.now - usual) / usual) * 100) : 0 };
    })
    .filter((r) => r.overCents >= 2000 && r.pct >= 25)
    .sort((x, y) => y.overCents - x.overCents);
}

// Money in and out by day for one month, by the transaction date (what hit the bank)
export async function cashFlow(db: Db, ym: YM) {
  const { from, to } = monthDateRange(ym.year, ym.month);
  const rows = await db
    .select({ date: transactions.date, merchant: transactions.merchant, type: transactions.type, cents: transactions.amountCents, pending: transactions.pending })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), sql`${transactions.date} between ${from} and ${to}`))
    .orderBy(asc(transactions.date), asc(transactions.id));
  const days = new Map<string, { date: string; inCents: number; outCents: number; items: { merchant: string; cents: number; type: "income" | "expense" }[] }>();
  for (const r of rows) {
    const d = days.get(r.date) ?? { date: r.date, inCents: 0, outCents: 0, items: [] };
    if (r.type === "income") d.inCents += r.cents;
    else d.outCents += r.cents;
    d.items.push({ merchant: r.merchant, cents: r.cents, type: r.type });
    days.set(r.date, d);
  }
  return { year: ym.year, month: ym.month, days: [...days.values()] };
}
