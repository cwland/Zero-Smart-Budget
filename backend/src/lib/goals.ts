import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, lineItems } from "../db/schema.js";
import { nextSortOrder } from "./budget.js";
import { monthIndex } from "./calc.js";
import { syncLineItem } from "./fundLedger.js";

// Personal goals (like EveryDollar's): a target amount, an optional month to reach it by, and a
// line in your budget that saves toward it each month.

export const GOALS_GROUP = "Goals";

// How much a goal needs each month to reach its target by its date (counting this month)
export function goalPlan(
  f: { kind: string; targetCents: number | null; targetDate: string | null; balanceCents: number },
  now: Date
) {
  if (f.kind !== "goal" || f.targetCents === null) return null;
  const neededCents = Math.max(0, f.targetCents - f.balanceCents);
  if (!f.targetDate) return { neededCents, monthsLeft: null, monthlyCents: null, overdue: false };
  const [y, m] = f.targetDate.split("-").map(Number);
  const monthsLeft = monthIndex(y, m) - monthIndex(now.getFullYear(), now.getMonth() + 1) + 1;
  return {
    neededCents,
    monthsLeft: Math.max(0, monthsLeft),
    monthlyCents: neededCents === 0 ? 0 : Math.ceil(neededCents / Math.max(1, monthsLeft)),
    overdue: monthsLeft < 1 && neededCents > 0,
  };
}

// "This goal will be added to your budget": a line in this month's Goals group, linked to the goal.
// Skipped when this month has no budget yet or is closed (link it from the budget later).
export async function addGoalToBudget(db: Db, goal: { id: number; name: string }, plannedCents: number, now: Date) {
  const [month] = await db
    .select()
    .from(budgetMonths)
    .where(and(eq(budgetMonths.year, now.getFullYear()), eq(budgetMonths.month, now.getMonth() + 1)));
  if (!month || month.closedAt) return null;
  let [group] = await db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.monthId, month.id), sql`lower(${categoryGroups.name}) = lower(${GOALS_GROUP})`))
    .orderBy(asc(categoryGroups.id))
    .limit(1);
  if (!group) {
    [group] = await db
      .insert(categoryGroups)
      .values({ monthId: month.id, name: GOALS_GROUP, sortOrder: await nextSortOrder(db, categoryGroups, eq(categoryGroups.monthId, month.id)) })
      .returning();
  }
  const [item] = await db
    .insert(lineItems)
    .values({
      groupId: group.id,
      name: goal.name,
      plannedCents,
      sinkingFundId: goal.id,
      sortOrder: await nextSortOrder(db, lineItems, eq(lineItems.groupId, group.id)),
    })
    .returning();
  await syncLineItem(db, item.id);
  return { year: month.year, month: month.month, itemId: item.id, groupName: group.name, plannedCents };
}
