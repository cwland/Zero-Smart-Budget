import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, plaidAccounts, plaidItems, transactions, transactionSplits } from "../db/schema.js";
import { syncTransaction } from "./fundLedger.js";
import { normalizeMerchant } from "./merchant.js";
import { PlaidError, type PlaidEnv, type PlaidService } from "./plaid.js";

// Imports bank transactions with Plaid's /transactions/sync. Plaid keeps a cursor per bank and
// sends only what changed since last time: added, modified and removed transactions.
//  - Plaid amounts are positive for money out (expense) and negative for money in (income)
//  - A pending charge that posts arrives as a new transaction pointing at the pending one
//    (pending_transaction_id); we update the existing row so its budget assignment is kept
//  - New transactions come in unassigned; Fast Track suggestions show on them as usual

interface PlaidTx {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
}
interface SyncPage {
  added: PlaidTx[];
  modified: PlaidTx[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
  accounts?: { account_id: string; balances: { current: number | null; available: number | null } }[];
}

export interface ItemSyncResult {
  itemId: number;
  institutionName: string;
  added: number;
  updated: number;
  removed: number;
  error?: string;
}

// Plaid errors that mean "sign in to the bank again"
export const LOGIN_ERRORS = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "INVALID_CREDENTIALS",
  "INSUFFICIENT_CREDENTIALS",
  "USER_SETUP_REQUIRED",
  "MFA_NOT_SUPPORTED",
  "NO_ACCOUNTS",
]);

export async function markItemError(db: Db, itemId: number, e: PlaidError) {
  const status = LOGIN_ERRORS.has(e.code) ? "login_required" : "error";
  await db.update(plaidItems).set({ status, errorCode: e.code, errorMessage: e.message }).where(eq(plaidItems.id, itemId));
  return status;
}

const cents = (n: number) => Math.round(Math.abs(n) * 100);
const typeOf = (t: PlaidTx) => (t.amount < 0 ? "income" : "expense") as "income" | "expense";
const toCents = (n: number | null) => (n === null ? null : Math.round(n * 100));

// Fetch every page since the saved cursor. If the bank's data changes mid-way, Plaid asks us to
// start over from the same cursor.
async function fetchChanges(plaid: PlaidService, keysEnv: PlaidEnv, accessToken: string, cursor: string | null) {
  const keys = await plaid.keysFor(keysEnv);
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = { added: [] as PlaidTx[], modified: [] as PlaidTx[], removed: [] as string[], cursor, accounts: [] as NonNullable<SyncPage["accounts"]> };
    try {
      let next = cursor;
      for (;;) {
        const page = await plaid.call<SyncPage>("/transactions/sync", { access_token: accessToken, count: 500, ...(next ? { cursor: next } : {}) }, keys);
        out.added.push(...page.added);
        out.modified.push(...page.modified);
        out.removed.push(...page.removed.map((r) => r.transaction_id));
        if (page.accounts) out.accounts = page.accounts;
        next = page.next_cursor;
        if (!page.has_more) break;
      }
      out.cursor = next;
      return out;
    } catch (e) {
      if (e instanceof PlaidError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
      throw e;
    }
  }
  throw new PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR", "The bank kept changing while syncing. Try again in a minute.");
}

type Row = typeof transactions.$inferSelect;

// Apply a new amount/date/type to an existing row, keeping its budget assignment when it still fits.
// Returns false when nothing actually changed (e.g. re-reading history we already have).
async function updateRow(db: Db, row: Row, t: PlaidTx, newPlaidId: string) {
  const amountCents = cents(t.amount);
  const type = typeOf(t);
  const same =
    row.plaidTransactionId === newPlaidId && row.plaidAccountId === t.account_id && row.amountCents === amountCents && row.type === type && row.date === t.date && row.pending === t.pending;
  if (same) return false;
  const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, row.id));
  const sameMonth = row.date.slice(0, 7) === t.date.slice(0, 7);
  if (splits.length) {
    if (type !== row.type || !sameMonth) {
      // Assigned to items in another month or of the other kind: send it back to unassigned
      await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, row.id));
    } else if (amountCents !== row.amountCents) {
      if (splits.length === 1) await db.update(transactionSplits).set({ amountCents }).where(eq(transactionSplits.id, splits[0].id));
      else await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, row.id)); // split no longer adds up
    }
  }
  await db
    .update(transactions)
    .set({ plaidTransactionId: newPlaidId, plaidAccountId: t.account_id, amountCents, type, date: t.date, pending: t.pending })
    .where(eq(transactions.id, row.id));
  return true;
}

export async function syncItem(db: Db, plaid: PlaidService, item: typeof plaidItems.$inferSelect): Promise<ItemSyncResult> {
  const result: ItemSyncResult = { itemId: item.id, institutionName: item.institutionName, added: 0, updated: 0, removed: 0 };
  const changes = await fetchChanges(plaid, item.env as PlaidEnv, plaid.decryptToken(item.accessTokenEnc), item.cursor);

  const accounts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.plaidItemId, item.id));
  const importing = new Map(accounts.map((a) => [a.accountId, a.importTransactions]));
  const wanted = (t: PlaidTx) => t.date >= item.importFrom && importing.get(t.account_id) !== false && t.amount !== 0;

  const touched = new Set<number>();
  await db.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const byPlaidId = async (ids: string[]) =>
      ids.length ? new Map((await tx.select().from(transactions).where(inArray(transactions.plaidTransactionId, ids))).map((r) => [r.plaidTransactionId!, r])) : new Map<string, Row>();

    // Added (including pending charges that just posted)
    const existing = await byPlaidId(changes.added.flatMap((t) => [t.transaction_id, ...(t.pending_transaction_id ? [t.pending_transaction_id] : [])]));
    for (const t of changes.added) {
      const already = existing.get(t.transaction_id) ?? (t.pending_transaction_id ? existing.get(t.pending_transaction_id) : undefined);
      if (already) {
        if (await updateRow(tx, already, t, t.transaction_id)) {
          touched.add(already.id);
          result.updated++;
        }
        continue;
      }
      if (!wanted(t)) continue;
      const merchant = (t.merchant_name || t.name || "Bank transaction").slice(0, 200);
      const [row] = await tx
        .insert(transactions)
        .values({
          date: t.date,
          merchant,
          merchantKey: normalizeMerchant(merchant),
          amountCents: cents(t.amount),
          type: typeOf(t),
          plaidTransactionId: t.transaction_id,
          plaidAccountId: t.account_id,
          pending: t.pending,
        })
        .returning({ id: transactions.id });
      touched.add(row.id);
      result.added++;
    }

    // Modified: amounts and dates change (e.g. a tip added to a restaurant charge). The merchant
    // name isn't touched, in case it was renamed here.
    const mods = await byPlaidId(changes.modified.map((t) => t.transaction_id));
    for (const t of changes.modified) {
      const row = mods.get(t.transaction_id);
      if (!row || !(await updateRow(tx, row, t, t.transaction_id))) continue;
      touched.add(row.id);
      result.updated++;
    }

    // Removed: usually a pending charge that dropped off or was replaced
    if (changes.removed.length) {
      const gone = await tx.delete(transactions).where(inArray(transactions.plaidTransactionId, changes.removed)).returning({ id: transactions.id });
      gone.forEach((g) => touched.delete(g.id));
      result.removed = gone.length;
    }

    for (const a of changes.accounts) {
      await tx
        .update(plaidAccounts)
        .set({ currentBalanceCents: toCents(a.balances.current), availableBalanceCents: toCents(a.balances.available) })
        .where(eq(plaidAccounts.accountId, a.account_id));
    }
    await tx
      .update(plaidItems)
      .set({ cursor: changes.cursor, lastSyncedAt: new Date(), status: "ok", errorCode: null, errorMessage: null })
      .where(eq(plaidItems.id, item.id));
  });

  // Keep sinking fund history in step with any amounts that changed
  for (const id of touched) await syncTransaction(db, id);
  return result;
}

// Sync every bank connected with the keys currently selected. One sync at a time.
let running: Promise<ItemSyncResult[]> | null = null;
export function syncAll(db: Db, plaid: PlaidService): Promise<ItemSyncResult[]> {
  running ??= (async () => {
    try {
      const env = (await plaid.stored())?.env;
      if (!env) return [];
      const items = await db.select().from(plaidItems).where(eq(plaidItems.env, env));
      const results: ItemSyncResult[] = [];
      for (const item of items) {
        try {
          results.push(await syncItem(db, plaid, item));
        } catch (e) {
          let error = (e as Error).message;
          if (e instanceof PlaidError) {
            const status = await markItemError(db, item.id, e);
            error = status === "login_required" ? `${item.institutionName} needs you to sign in again. Reconnect it in Settings > Plaid.` : `${e.message} (${e.code})`;
          }
          results.push({ itemId: item.id, institutionName: item.institutionName, added: 0, updated: 0, removed: 0, error });
        }
      }
      return results;
    } finally {
      running = null;
    }
  })();
  return running;
}

// Months that have transactions but no budget yet (those transactions only show once the month is
// created), e.g. [{ year: 2026, month: 7, count: 16 }]
export async function monthsWaiting(db: Db) {
  const r = await db.execute(sql`
    select extract(year from t.date)::int as year, extract(month from t.date)::int as month, count(*)::int as count
    from ${transactions} t
    where t.deleted_at is null and not exists (
      select 1 from ${budgetMonths} m
      where m.year = extract(year from t.date)::int and m.month = extract(month from t.date)::int
    )
    group by 1, 2 order by 1, 2`);
  return r.rows as { year: number; month: number; count: number }[];
}
