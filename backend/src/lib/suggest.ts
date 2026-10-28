import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, incomeItems, lineItems, transactions, transactionSplits } from "../db/schema.js";
import { syncTransaction } from "./fundLedger.js";
import { getBudgetPrefs } from "./prefs.js";

// A suggested budget item for an unassigned transaction, learned from how the same merchant
// was assigned before (most recent wins). Items are matched by name in the transaction's own
// month, since every month has its own copy of "Groceries" or "Paycheck 2".
export interface Suggestion {
  lineItemId?: number;
  incomeItemId?: number;
  itemName: string;
  groupName: string; // "Income" for income items
}

interface Target {
  id: number;
  date: string;
  type: "expense" | "income";
  merchantKey: string | null;
  amountCents?: number | null;
}

interface Past {
  date: string;
  amount: number;
  lineItemId: number | null;
  incomeItemId: number | null;
}

const dayOf = (d: string) => Number(d.slice(8, 10));
// Distance between two days of the month, wrapping around (the 30th is close to the 1st)
const dayGap = (a: number, b: number) => Math.min(Math.abs(a - b), 31 - Math.abs(a - b));

// Which past assignment should this transaction follow?
//  - Usually the most recent one (so re-categorizing a merchant sticks).
//  - But some merchants map to several items in the same month, like one employer paying
//    Paycheck 1 on the 1st and Paycheck 2 on the 15th. If any of the merchant's last 3 months
//    shows that, use the most recent such month and pick the item closest in day of month
//    (and amount). This keeps working even after you've accepted part of the current month.
function choose(past: Past[], t: Target): Past | undefined {
  if (!past.length) return undefined;
  const months: string[] = [];
  for (const p of past) {
    const m = p.date.slice(0, 7);
    if (!months.includes(m)) months.push(m);
  }
  const target = (p: Past) => `${p.lineItemId}|${p.incomeItemId}`;
  const multiMonth = months.slice(0, 3).find((m) => new Set(past.filter((p) => p.date.slice(0, 7) === m).map(target)).size > 1);
  if (!multiMonth) return past[0];

  const candidates = past.filter((p) => p.date.slice(0, 7) === multiMonth);
  const day = dayOf(t.date);
  const score = (p: Past) =>
    dayGap(day, dayOf(p.date)) / 15 + (t.amountCents ? Math.abs(p.amount - t.amountCents) / Math.max(p.amount, t.amountCents) : 0);
  return [...candidates].sort((a, b) => score(a) - score(b))[0];
}

const lower = (s: string) => s.trim().toLowerCase();

export async function suggestFor(db: Db, targets: Target[], opts: { ignoreFastTrack?: boolean } = {}): Promise<Map<number, Suggestion>> {
  const out = new Map<number, Suggestion>();
  // Fast Track turned off in Settings (the AI still checks history, so it never guesses where history knows)
  if (!opts.ignoreFastTrack && !(await getBudgetPrefs(db)).fastTrack) return out;
  const keys = [...new Set(targets.map((t) => t.merchantKey).filter((k): k is string => !!k))];
  if (!keys.length) return out;

  // 1. Past assignments for these merchants, newest first. Exact cleaned-up name first; if a
  //    merchant has no exact history, fall back to its first two words ("winco foods #77" matches
  //    "winco foods weekly groceries").
  const prefixOf = (k: string) => {
    const words = k.split(" ");
    return words.length >= 2 ? words.slice(0, 2).join(" ") : words[0].length >= 4 ? words[0] : null;
  };
  const prefixes = [...new Set(keys.map(prefixOf).filter((p): p is string => !!p))];
  const keyMatch = or(
    inArray(transactions.merchantKey, keys),
    ...prefixes.map((p) => sql`(${transactions.merchantKey} = ${p} or ${transactions.merchantKey} like ${p + " %"})`)
  );
  const history = await db
    .select({
      txId: transactions.id,
      key: transactions.merchantKey,
      type: transactions.type,
      date: transactions.date,
      lineItemId: transactionSplits.lineItemId,
      incomeItemId: transactionSplits.incomeItemId,
      amount: transactionSplits.amountCents,
    })
    .from(transactions)
    .innerJoin(transactionSplits, eq(transactionSplits.transactionId, transactions.id))
    .where(and(keyMatch, or(isNotNull(transactionSplits.lineItemId), isNotNull(transactionSplits.incomeItemId))))
    .orderBy(desc(transactions.date), desc(transactions.id), desc(transactionSplits.amountCents));

  // Past assignments per (merchant, type), newest first; for a split, only its biggest part
  const pastBy = new Map<string, Past[]>();
  const seenTx = new Set<number>();
  for (const h of history) {
    if (seenTx.has(h.txId)) continue; // rows are biggest-split-first within a transaction
    seenTx.add(h.txId);
    const k = `${h.type}|${h.key}`;
    const list = pastBy.get(k) ?? [];
    if (list.length < 12) list.push({ date: h.date, amount: h.amount, lineItemId: h.lineItemId, incomeItemId: h.incomeItemId });
    pastBy.set(k, list);
  }
  // Same, grouped by the two-word prefix (for the fallback)
  const pastByPrefix = new Map<string, Past[]>();
  for (const [k, list] of pastBy) {
    const [type, key] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const p = prefixOf(key);
    if (!p) continue;
    const merged = [...(pastByPrefix.get(`${type}|${p}`) ?? []), ...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    pastByPrefix.set(`${type}|${p}`, merged);
  }
  // A prefix is only trusted when every merchant sharing it was last filed under the same item
  // name. "sinking fund travel" and "sinking fund holiday gifts" share "sinking fund" but go to
  // different items, so a new "sinking fund ..." merchant gets no guess.
  const latestByPrefix = new Map<string, Past[]>(); // newest assignment of each merchant under a prefix
  for (const [k, list] of pastBy) {
    const [type, key] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const p = prefixOf(key);
    if (p) latestByPrefix.set(`${type}|${p}`, [...(latestByPrefix.get(`${type}|${p}`) ?? []), list[0]]);
  }
  const mixed = [...latestByPrefix.values()].filter((l) => l.length > 1);
  const mixedLineIds = [...new Set(mixed.flat().flatMap((p) => (p.lineItemId ? [p.lineItemId] : [])))];
  const mixedIncomeIds = [...new Set(mixed.flat().flatMap((p) => (p.incomeItemId ? [p.incomeItemId] : [])))];
  const nameOf = new Map<string, string>([
    ...(mixedLineIds.length ? await db.select({ id: lineItems.id, name: lineItems.name }).from(lineItems).where(inArray(lineItems.id, mixedLineIds)) : []).map((r) => [`l${r.id}`, lower(r.name)] as [string, string]),
    ...(mixedIncomeIds.length ? await db.select({ id: incomeItems.id, name: incomeItems.name }).from(incomeItems).where(inArray(incomeItems.id, mixedIncomeIds)) : []).map((r) => [`i${r.id}`, lower(r.name)] as [string, string]),
  ]);
  const prefixIsClear = (pk: string) => {
    const l = latestByPrefix.get(pk) ?? [];
    return new Set(l.map((p) => (p.lineItemId ? nameOf.get(`l${p.lineItemId}`) : nameOf.get(`i${p.incomeItemId}`)))).size <= 1;
  };

  const learned = new Map<number, { lineItemId: number | null; incomeItemId: number | null }>(); // by target tx id
  for (const t of targets) {
    if (!t.merchantKey) continue;
    const exact = pastBy.get(`${t.type}|${t.merchantKey}`);
    const p = prefixOf(t.merchantKey);
    const pk = `${t.type}|${p}`;
    const pick = choose(exact?.length ? exact : p && prefixIsClear(pk) ? pastByPrefix.get(pk) ?? [] : [], t);
    if (pick) learned.set(t.id, pick);
  }
  if (!learned.size) return out;

  // 2. Names of the learned items
  const lineIds = [...learned.values()].flatMap((l) => (l.lineItemId ? [l.lineItemId] : []));
  const incomeIds = [...learned.values()].flatMap((l) => (l.incomeItemId ? [l.incomeItemId] : []));
  const lineNames = lineIds.length
    ? await db
        .select({ id: lineItems.id, name: lineItems.name, group: categoryGroups.name })
        .from(lineItems)
        .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
        .where(inArray(lineItems.id, lineIds))
    : [];
  const incomeNames = incomeIds.length ? await db.select({ id: incomeItems.id, name: incomeItems.name }).from(incomeItems).where(inArray(incomeItems.id, incomeIds)) : [];

  // 3. Items in each target's month
  const months = [...new Set(targets.map((t) => t.date.slice(0, 7)))];
  const monthRows = await db
    .select({ id: budgetMonths.id, year: budgetMonths.year, month: budgetMonths.month })
    .from(budgetMonths)
    .where(inArray(sql`${budgetMonths.year} || '-' || lpad(${budgetMonths.month}::text, 2, '0')`, months));
  const monthIdByKey = new Map(monthRows.map((m) => [`${m.year}-${String(m.month).padStart(2, "0")}`, m.id]));
  const monthIds = monthRows.map((m) => m.id);
  const monthLines = monthIds.length
    ? await db
        .select({ id: lineItems.id, name: lineItems.name, group: categoryGroups.name, monthId: categoryGroups.monthId })
        .from(lineItems)
        .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
        .where(inArray(categoryGroups.monthId, monthIds))
    : [];
  const monthIncome = monthIds.length
    ? await db.select({ id: incomeItems.id, name: incomeItems.name, monthId: incomeItems.monthId }).from(incomeItems).where(inArray(incomeItems.monthId, monthIds))
    : [];

  for (const t of targets) {
    const l = learned.get(t.id);
    const monthId = monthIdByKey.get(t.date.slice(0, 7));
    if (!l || !monthId) continue;

    if (l.lineItemId) {
      const src = lineNames.find((x) => x.id === l.lineItemId);
      if (!src) continue;
      const inMonth = monthLines.filter((x) => x.monthId === monthId && lower(x.name) === lower(src.name));
      const match = inMonth.find((x) => lower(x.group) === lower(src.group)) ?? (inMonth.length === 1 ? inMonth[0] : undefined);
      if (match) out.set(t.id, { lineItemId: match.id, itemName: match.name, groupName: match.group });
    } else if (l.incomeItemId) {
      const src = incomeNames.find((x) => x.id === l.incomeItemId);
      const match = src && monthIncome.find((x) => x.monthId === monthId && lower(x.name) === lower(src.name));
      if (match) out.set(t.id, { incomeItemId: match.id, itemName: match.name, groupName: "Income" });
    }
  }
  return out;
}

// Put the whole transaction on the suggested item
export async function assignToSuggestion(db: Db, txId: number, amountCents: number, s: Suggestion) {
  await db.transaction(async (tx) => {
    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, txId));
    await tx.insert(transactionSplits).values({
      transactionId: txId,
      amountCents,
      lineItemId: s.lineItemId ?? null,
      incomeItemId: s.incomeItemId ?? null,
    });
  });
  await syncTransaction(db, txId);
}
