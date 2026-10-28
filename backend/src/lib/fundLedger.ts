import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  budgetMonths,
  categoryGroups,
  fundEntries,
  lineItems,
  transactions,
  transactionSplits,
} from "../db/schema.js";

// Keeps each fund's history (fund_entries) in step with the budget.
// Rules:
//  - A linked line item has one "budgeted" entry (its planned amount, dated the 1st of its month).
//  - Each transaction with splits on a linked item has one "spent" entry per item: negative for
//    expenses, positive for income put on the item (money back, e.g. the + side of a transfer).
//  - Only entries for items that are CURRENTLY linked are touched. Unlinking or deleting an item
//    leaves its entries frozen, so a fund's past never changes by accident.

const pad = (n: number) => String(n).padStart(2, "0");

// Call after creating or changing a line item (planned amount, name, fund link, or group).
export async function syncLineItem(db: Db, lineItemId: number) {
  const [item] = await db
    .select({
      id: lineItems.id,
      name: lineItems.name,
      plannedCents: lineItems.plannedCents,
      fundId: lineItems.sinkingFundId,
      year: budgetMonths.year,
      month: budgetMonths.month,
    })
    .from(lineItems)
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
    .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
    .where(eq(lineItems.id, lineItemId));
  if (!item || item.fundId === null) return; // unlinked: history stays frozen

  // Budgeted entry
  const date = `${item.year}-${pad(item.month)}-01`;
  const [existing] = await db
    .select({ id: fundEntries.id })
    .from(fundEntries)
    .where(and(eq(fundEntries.lineItemId, item.id), eq(fundEntries.kind, "budgeted")));
  if (item.plannedCents === 0) {
    if (existing) await db.delete(fundEntries).where(eq(fundEntries.id, existing.id));
  } else if (existing) {
    await db
      .update(fundEntries)
      .set({ fundId: item.fundId, amountCents: item.plannedCents, date, description: item.name })
      .where(eq(fundEntries.id, existing.id));
  } else {
    await db.insert(fundEntries).values({
      fundId: item.fundId,
      kind: "budgeted",
      date,
      amountCents: item.plannedCents,
      description: item.name,
      lineItemId: item.id,
    });
  }

  // Spending on this item: (re)build from its transactions
  const txIds = await db
    .selectDistinct({ id: transactionSplits.transactionId })
    .from(transactionSplits)
    .where(eq(transactionSplits.lineItemId, item.id));
  for (const t of txIds) await syncTransaction(db, t.id);
}

// Call after creating or replacing a transaction (deleting one removes its entries automatically).
export async function syncTransaction(db: Db, transactionId: number) {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!tx) return;

  // Amount per linked line item in this transaction
  const parts = await db
    .select({
      lineItemId: transactionSplits.lineItemId,
      fundId: lineItems.sinkingFundId,
      total: sql<string>`sum(${transactionSplits.amountCents})`,
    })
    .from(transactionSplits)
    .innerJoin(lineItems, eq(transactionSplits.lineItemId, lineItems.id))
    .where(and(eq(transactionSplits.transactionId, tx.id), isNotNull(lineItems.sinkingFundId)))
    .groupBy(transactionSplits.lineItemId, lineItems.sinkingFundId);

  const existing = await db
    .select({ id: fundEntries.id, lineItemId: fundEntries.lineItemId, itemFund: lineItems.sinkingFundId })
    .from(fundEntries)
    .leftJoin(lineItems, eq(fundEntries.lineItemId, lineItems.id))
    .where(and(eq(fundEntries.transactionId, tx.id), eq(fundEntries.kind, "spent")));

  // Remove entries for items that are still linked but no longer in this transaction
  const stale = existing.filter((e) => e.itemFund !== null && !parts.some((p) => p.lineItemId === e.lineItemId));
  if (stale.length) await db.delete(fundEntries).where(inArray(fundEntries.id, stale.map((e) => e.id)));

  for (const p of parts) {
    // Expenses take money out of the fund; income on the item (money back) puts it back
    const amountCents = tx.type === "income" ? Number(p.total) : -Number(p.total);
    const found = existing.find((e) => e.lineItemId === p.lineItemId);
    if (found) {
      await db
        .update(fundEntries)
        .set({ fundId: p.fundId!, amountCents, date: tx.date, description: tx.merchant })
        .where(eq(fundEntries.id, found.id));
    } else {
      await db.insert(fundEntries).values({
        fundId: p.fundId!,
        kind: "spent",
        date: tx.date,
        amountCents,
        description: tx.merchant,
        lineItemId: p.lineItemId,
        transactionId: tx.id,
      });
    }
  }
}

// Rebuild every entry from scratch (used when restoring an old backup that has no history)
export async function rebuildAllEntries(db: Db) {
  await db.delete(fundEntries);
  const linked = await db.select({ id: lineItems.id }).from(lineItems).where(isNotNull(lineItems.sinkingFundId));
  for (const l of linked) await syncLineItem(db, l.id);
}
