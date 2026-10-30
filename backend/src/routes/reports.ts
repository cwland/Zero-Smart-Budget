import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { budgetMonths, categoryGroups, incomeItems, lineItems, transactions, transactionSplits } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";

// Reports: spending and income totals for a range of budget months.
// Money counts in the budget month of the item it's assigned to (like the budget page does),
// and groups, items and income sources are matched across months by name.

const ym = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM")
  .transform((v) => ({ year: Number(v.slice(0, 4)), month: Number(v.slice(5, 7)) }))
  .refine((v) => v.month >= 1 && v.month <= 12, "Not a real month");

const idx = (year: number, month: number) => year * 12 + (month - 1);
const monthExpr = sql<number>`${budgetMonths.year} * 12 + ${budgetMonths.month} - 1`;

export default async function reportRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/api/reports", async (req) => {
    const q = z.object({ from: ym, to: ym }).parse(req.query);
    const from = idx(q.from.year, q.from.month);
    const to = idx(q.to.year, q.to.month);
    if (from > to) throw badRequest("The start month is after the end month");
    if (to - from > 120) throw badRequest("Pick ten years or less");
    const inRange = sql`${monthExpr} between ${from} and ${to}`;

    // Every month in the range, budget or not, so charts show gaps as $0
    const months: { year: number; month: number }[] = [];
    for (let i = from; i <= to; i++) months.push({ year: Math.floor(i / 12), month: (i % 12) + 1 });

    // Net spending per item per month: expenses add, refunds (income on a budget item) subtract
    const spendRows = await db
      .select({
        year: budgetMonths.year,
        month: budgetMonths.month,
        group: categoryGroups.name,
        groupOrder: categoryGroups.sortOrder,
        item: lineItems.name,
        itemOrder: lineItems.sortOrder,
        cents: sql<string>`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end)`,
      })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
      .innerJoin(lineItems, eq(transactionSplits.lineItemId, lineItems.id))
      .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
      .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
      .where(and(inRange, isNull(transactions.deletedAt)))
      .groupBy(budgetMonths.year, budgetMonths.month, categoryGroups.name, categoryGroups.sortOrder, lineItems.name, lineItems.sortOrder)
      .orderBy(asc(budgetMonths.year), asc(budgetMonths.month), asc(categoryGroups.sortOrder), asc(lineItems.sortOrder));

    // Money received per income source per month (a Month Close rollover isn't new income)
    const incomeRows = await db
      .select({
        year: budgetMonths.year,
        month: budgetMonths.month,
        source: incomeItems.name,
        order: incomeItems.sortOrder,
        cents: sql<string>`sum(${transactionSplits.amountCents})`,
      })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
      .innerJoin(incomeItems, eq(transactionSplits.incomeItemId, incomeItems.id))
      .innerJoin(budgetMonths, eq(incomeItems.monthId, budgetMonths.id))
      .where(and(inRange, isNull(transactions.deletedAt), isNull(incomeItems.rolloverFromMonthId)))
      .groupBy(budgetMonths.year, budgetMonths.month, incomeItems.name, incomeItems.sortOrder)
      .orderBy(asc(budgetMonths.year), asc(budgetMonths.month), asc(incomeItems.sortOrder));

    // Years with a budget, for the "2025"-style choices in the date filter
    const years = (await db.selectDistinct({ year: budgetMonths.year }).from(budgetMonths).orderBy(asc(budgetMonths.year))).map((r) => r.year);

    // Merge rows that only differ by sort order (same name in a month)
    const spending = new Map<string, { year: number; month: number; group: string; item: string; cents: number }>();
    for (const r of spendRows) {
      const k = `${r.year}-${r.month}|${r.group}|${r.item}`;
      const row = spending.get(k) ?? { year: r.year, month: r.month, group: r.group, item: r.item, cents: 0 };
      row.cents += Number(r.cents);
      spending.set(k, row);
    }
    const income = new Map<string, { year: number; month: number; source: string; cents: number }>();
    for (const r of incomeRows) {
      const k = `${r.year}-${r.month}|${r.source}`;
      const row = income.get(k) ?? { year: r.year, month: r.month, source: r.source, cents: 0 };
      row.cents += Number(r.cents);
      income.set(k, row);
    }

    return { months, years, spending: [...spending.values()], income: [...income.values()] };
  });
}
