import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import {
  budgetMonths,
  categoryGroups,
  fundEntries,
  incomeItems,
  manualAccounts,
  lineItems,
  sinkingFunds,
  transactions,
  transactionSplits,
} from "../db/schema.js";
import { loadBudget } from "./budget.js";
import { rebuildAllEntries } from "./fundLedger.js";
import { backfillMerchantKeys } from "./merchant.js";
import { exportSettings, importSettings, type BackupSecrets, type SettingsSection } from "./settingsBackup.js";

export const EXPORT_VERSION = 4; // 2 added fundEntries, 3 Month Close (closed months, goals, rollovers), 4 settings

// Everything except the login, API keys and bank connections. Settings are included; their saved
// keys and passwords only when BACKUP_KEY is set (encrypted with it; see settingsBackup.ts)
export async function buildExport(db: Db, secrets: BackupSecrets) {
  return {
    app: "ZeroPoint Budget",
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    months: await db.select().from(budgetMonths).orderBy(asc(budgetMonths.id)),
    incomeItems: await db.select().from(incomeItems).orderBy(asc(incomeItems.id)),
    groups: await db.select().from(categoryGroups).orderBy(asc(categoryGroups.id)),
    lineItems: await db.select().from(lineItems).orderBy(asc(lineItems.id)),
    sinkingFunds: await db.select().from(sinkingFunds).orderBy(asc(sinkingFunds.id)),
    transactions: await db.select().from(transactions).orderBy(asc(transactions.id)),
    transactionSplits: await db.select().from(transactionSplits).orderBy(asc(transactionSplits.id)),
    fundEntries: await db.select().from(fundEntries).orderBy(asc(fundEntries.id)),
    manualAccounts: await db.select().from(manualAccounts).orderBy(asc(manualAccounts.id)),
    settings: await exportSettings(db, secrets),
  };
}

// ---------- CSV ----------

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function toCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Stop spreadsheet apps from treating text like "=SUM(...)" as a formula
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// One row per split, so split transactions show each part. Unassigned transactions get one row.
export async function transactionsCsv(db: Db, from?: string, to?: string) {
  const lines = await db
    .select({ id: lineItems.id, name: lineItems.name, group: categoryGroups.name })
    .from(lineItems)
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id));
  const income = await db.select({ id: incomeItems.id, name: incomeItems.name }).from(incomeItems);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const incomeById = new Map(income.map((i) => [i.id, i]));

  const txs = await db.query.transactions.findMany({
    where: (t, { and, gte, lte, isNull }) => and(from ? gte(t.date, from) : undefined, to ? lte(t.date, to) : undefined, isNull(t.deletedAt)),
    orderBy: (t, { asc }) => [asc(t.date), asc(t.id)],
    with: { splits: { orderBy: (s, { asc }) => [asc(s.id)] } },
  });

  const rows: (string | number | null)[][] = [
    ["Date", "Merchant", "Type", "Total", "Amount", "Group", "Item", "Split", "Note"],
  ];
  for (const t of txs) {
    const parts = t.splits.length ? t.splits : [null];
    for (const s of parts) {
      const line = s?.lineItemId ? lineById.get(s.lineItemId) : undefined;
      const inc = s?.incomeItemId ? incomeById.get(s.incomeItemId) : undefined;
      rows.push([
        t.date,
        t.merchant,
        t.type,
        dollars(t.amountCents),
        dollars(s ? s.amountCents : t.amountCents),
        line ? line.group : inc ? "Income" : "",
        line ? line.name : inc ? inc.name : "Unassigned",
        t.splits.length > 1 ? "yes" : "",
        t.note,
      ]);
    }
  }
  return toCsv(rows);
}

// Planned / spent / remaining for every item, one month or all months
export async function budgetCsv(db: Db, year?: number, month?: number) {
  const months = await db
    .select()
    .from(budgetMonths)
    .where(year && month ? sql`${budgetMonths.year} = ${year} and ${budgetMonths.month} = ${month}` : undefined)
    .orderBy(asc(budgetMonths.year), asc(budgetMonths.month));

  const rows: (string | number | null)[][] = [
    ["Month", "Group", "Item", "Planned", "Spent/Received", "Remaining", "Sinking Fund"],
  ];
  for (const m of months) {
    const b = await loadBudget(db, m.id);
    if (!b) continue;
    const label = `${b.year}-${String(b.month).padStart(2, "0")}`;
    for (const i of b.income) {
      rows.push([label, "Income", i.name, dollars(i.plannedCents), dollars(i.receivedCents), dollars(i.plannedCents - i.receivedCents), ""]);
    }
    for (const g of b.groups) {
      for (const i of g.items) {
        rows.push([label, g.name, i.name, dollars(i.plannedCents), dollars(i.spentCents), dollars(i.remainingCents), i.sinkingFund?.name ?? ""]);
      }
    }
  }
  return toCsv(rows);
}

// ---------- Restore ----------

const rows = z.array(z.record(z.string(), z.unknown()));
export const importSchema = z.object({
  app: z.enum(["ZeroPoint Budget", "Cory's Dollar"]), // backups made before the rename still restore
  exportVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  months: rows,
  incomeItems: rows,
  groups: rows,
  lineItems: rows,
  sinkingFunds: rows,
  transactions: rows,
  transactionSplits: rows,
  fundEntries: rows.optional(), // missing in version 1 files: rebuilt from links
  manualAccounts: rows.optional(), // version 3+
  settings: z.object({ secrets: z.enum(["encrypted", "left out"]), values: z.record(z.string(), z.unknown()) }).optional(), // version 4+
});
export type ImportData = z.infer<typeof importSchema>;

// JSON turns dates into strings; turn timestamp fields back into Dates
function revive(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...row };
  for (const key of ["createdAt", "updatedAt", "lastUsedAt", "deletedAt", "closedAt", "balanceUpdatedAt"]) {
    if (typeof out[key] === "string") out[key] = new Date(out[key] as string);
  }
  return out;
}

async function insertChunks(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], table: any, data: Record<string, unknown>[]) {
  for (let i = 0; i < data.length; i += 500) {
    await tx.insert(table).values(data.slice(i, i + 500).map(revive));
  }
}

const TABLES = [
  "budget_months",
  "income_items",
  "category_groups",
  "sinking_funds",
  "line_items",
  "transactions",
  "transaction_splits",
  "fund_entries",
  "manual_accounts",
];

// Replaces ALL budget data with the backup's contents (the login and API keys are kept).
// Runs in one database transaction, so a bad file changes nothing.
export async function importData(db: Db, data: ImportData, secrets: BackupSecrets) {
  let settings: Awaited<ReturnType<typeof importSettings>> | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`truncate ${TABLES.join(", ")} restart identity cascade`));
    await insertChunks(tx, sinkingFunds, data.sinkingFunds);
    await insertChunks(tx, budgetMonths, data.months);
    await insertChunks(tx, incomeItems, data.incomeItems);
    await insertChunks(tx, categoryGroups, data.groups);
    await insertChunks(tx, lineItems, data.lineItems);
    await insertChunks(tx, transactions, data.transactions);
    await insertChunks(tx, transactionSplits, data.transactionSplits);
    if (data.fundEntries) await insertChunks(tx, fundEntries, data.fundEntries);
    if (data.manualAccounts?.length) await insertChunks(tx, manualAccounts, data.manualAccounts);
    // New rows should get ids after the restored ones
    for (const t of TABLES) {
      await tx.execute(
        sql.raw(`select setval(pg_get_serial_sequence('${t}', 'id'), coalesce((select max(id) from ${t}), 0) + 1, false)`)
      );
    }
    if (!data.fundEntries) await rebuildAllEntries(tx as unknown as Db);
    await backfillMerchantKeys(tx as unknown as Db); // older backups have no merchant keys
    if (data.settings) settings = await importSettings(tx as unknown as Db, data.settings as SettingsSection, secrets);
  });
  return {
    months: data.months.length,
    transactions: data.transactions.length,
    sinkingFunds: data.sinkingFunds.length,
    // null: an older backup without settings (yours were left as they are)
    settings,
  };
}
