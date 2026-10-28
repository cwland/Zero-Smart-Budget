import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  budgetMonths,
  categoryGroups,
  incomeItems,
  plaidAccounts,
  lineItems,
  transactions,
  transactionSplits,
} from "../db/schema.js";
import { monthDateRange } from "../lib/calc.js";
import { syncTransaction } from "../lib/fundLedger.js";
import { normalizeMerchant } from "../lib/merchant.js";
import { assignToSuggestion, suggestFor } from "../lib/suggest.js";
import { aiSuggestionsFor, autoSuggest, clearAiSuggestion, runAiSuggestions } from "../lib/aiSuggest.js";
import { AiError } from "../lib/ai.js";
import { badRequest, notFound } from "../lib/errors.js";
import { idParam, isoDate, name, positiveCents } from "../lib/validation.js";

const splitSchema = z
  .object({
    lineItemId: z.number().int().positive().optional(),
    incomeItemId: z.number().int().positive().optional(),
    amountCents: positiveCents,
  })
  .refine((s) => (s.lineItemId === undefined) !== (s.incomeItemId === undefined), {
    message: "Each split needs either lineItemId or incomeItemId",
  });

const transactionSchema = z.object({
  date: isoDate,
  merchant: name,
  amountCents: positiveCents,
  type: z.enum(["expense", "income"]).default("expense"),
  note: z.string().max(2000).nullable().optional(),
  // Empty = unassigned. One = normal. Several = split transaction.
  splits: z.array(splitSchema).default([]),
  // With no splits: put it on the item this merchant was assigned to last time (if any)
  autoAssign: z.boolean().optional(),
});

type TransactionInput = z.infer<typeof transactionSchema>;

const monthKeyOfDate = (date: string) => date.slice(0, 7); // "YYYY-MM"
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

// Splits must add up to the total, point at items in the transaction's month, and expenses
// can't go to income items
async function validateSplits(db: Db, input: TransactionInput) {
  const { splits, type, amountCents, date } = input;
  if (!splits.length) return;

  const total = splits.reduce((t, s) => t + s.amountCents, 0);
  if (total !== amountCents) throw badRequest("Splits must add up to the transaction amount");

  if (type === "expense" && splits.some((s) => s.incomeItemId)) {
    throw badRequest("Expenses can only be assigned to budget line items");
  }
  // Income may go to income items (paychecks) or to budget items, where it counts as money back
  // (a refund, or the incoming side of a transfer into a sinking fund)

  const wantedMonth = monthKeyOfDate(date);
  const lineIds = splits.flatMap((s) => (s.lineItemId ? [s.lineItemId] : []));
  const incomeIds = splits.flatMap((s) => (s.incomeItemId ? [s.incomeItemId] : []));

  if (lineIds.length) {
    const rows = await db
      .select({ id: lineItems.id, year: budgetMonths.year, month: budgetMonths.month })
      .from(lineItems)
      .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
      .innerJoin(budgetMonths, eq(categoryGroups.monthId, budgetMonths.id))
      .where(inArray(lineItems.id, lineIds));
    for (const id of lineIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw badRequest(`Line item ${id} not found`);
      if (monthKey(row.year, row.month) !== wantedMonth) {
        throw badRequest("Line items must be in the same month as the transaction date");
      }
    }
  }
  if (incomeIds.length) {
    const rows = await db
      .select({ id: incomeItems.id, year: budgetMonths.year, month: budgetMonths.month })
      .from(incomeItems)
      .innerJoin(budgetMonths, eq(incomeItems.monthId, budgetMonths.id))
      .where(inArray(incomeItems.id, incomeIds));
    for (const id of incomeIds) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw badRequest(`Income item ${id} not found`);
      if (monthKey(row.year, row.month) !== wantedMonth) {
        throw badRequest("Income items must be in the same month as the transaction date");
      }
    }
  }
}

async function loadTransaction(db: Db, id: number) {
  return db.query.transactions.findFirst({
    where: eq(transactions.id, id),
    with: {
      splits: {
        columns: { id: true, lineItemId: true, incomeItemId: true, amountCents: true },
        orderBy: (s, { asc }) => [asc(s.id)],
      },
    },
  });
}

export default async function transactionRoutes(app: FastifyInstance) {
  const { db } = app;

  // Filters: from/to (YYYY-MM-DD), or year+month; unassigned=true; lineItemId
  app.get("/api/transactions", async (req) => {
    const q = z
      .object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        year: z.coerce.number().int().optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
        unassigned: z.enum(["true", "false"]).optional(),
        lineItemId: z.coerce.number().int().positive().optional(),
        // Search: every word must match the merchant, note, budget item or bank account;
        // something like "12.50" or "$1,200" also matches that amount
        q: z.string().trim().max(100).optional(),
        // Deleted transactions are left out unless deleted=true, which lists only them
        deleted: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);

    let { from, to } = q;
    if (q.year && q.month) ({ from, to } = monthDateRange(q.year, q.month));

    const rows = await db.query.transactions.findMany({
      // Use the aliased table (t) the relational query gives us so subqueries match it
      where: (t) => {
        const filters: (SQL | undefined)[] = [
          from ? gte(t.date, from) : undefined,
          to ? lte(t.date, to) : undefined,
          q.deleted === "true" ? isNotNull(t.deletedAt) : isNull(t.deletedAt),
        ];
        if (q.unassigned === "true") {
          filters.push(
            sql`not exists (select 1 from ${transactionSplits} s where s.transaction_id = ${t.id} and (s.line_item_id is not null or s.income_item_id is not null))`
          );
        }
        if (q.q) {
          const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
          const wordMatches = q.q.split(/\s+/).filter(Boolean).map((w) => sql`(
            ${t.merchant} ilike ${like(w)}
            or coalesce(${t.note}, '') ilike ${like(w)}
            or exists (select 1 from ${transactionSplits} s join ${lineItems} li on li.id = s.line_item_id where s.transaction_id = ${t.id} and li.name ilike ${like(w)})
            or exists (select 1 from ${transactionSplits} s join ${incomeItems} ii on ii.id = s.income_item_id where s.transaction_id = ${t.id} and ii.name ilike ${like(w)})
            or exists (select 1 from ${plaidAccounts} pa where pa.account_id = ${t.plaidAccountId} and pa.name ilike ${like(w)})
          )`);
          const text = and(...wordMatches);
          const m = /^\$?(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/.exec(q.q);
          const amountCents = m ? Math.round(Number(q.q.replace(/[$,]/g, "")) * 100) : null;
          filters.push(amountCents !== null ? sql`(${text} or ${t.amountCents} = ${amountCents})` : text);
        }
        if (q.lineItemId) {
          filters.push(
            sql`exists (select 1 from ${transactionSplits} s where s.transaction_id = ${t.id} and s.line_item_id = ${q.lineItemId})`
          );
        }
        return and(...filters);
      },
      orderBy: [desc(transactions.date), desc(transactions.id)],
      ...(q.q ? { limit: 300 } : {}),
      with: {
        splits: {
          columns: { id: true, lineItemId: true, incomeItemId: true, amountCents: true },
          orderBy: (s, { asc }) => [asc(s.id)],
          with: { lineItem: { columns: { name: true } }, incomeItem: { columns: { name: true } } },
        },
      },
    });

    // Unassigned transactions get a suggestion learned from earlier ones
    const unassigned = rows.filter((r) => r.splits.every((sp) => !sp.lineItemId && !sp.incomeItemId));
    const suggestions = await suggestFor(db, unassigned);
    // Which bank account an imported transaction came from
    const accountIds = [...new Set(rows.flatMap((r) => (r.plaidAccountId ? [r.plaidAccountId] : [])))];
    const accounts = accountIds.length
      ? new Map(
          (await db.select({ accountId: plaidAccounts.accountId, name: plaidAccounts.name, mask: plaidAccounts.mask }).from(plaidAccounts).where(inArray(plaidAccounts.accountId, accountIds))).map((a) => [a.accountId, { name: a.name, mask: a.mask }])
        )
      : new Map<string, { name: string; mask: string | null }>();
    // AI guesses, only where history has nothing (history always wins)
    const aiTips = await aiSuggestionsFor(db, unassigned.filter((r) => !suggestions.has(r.id)));
    return rows.map((r) => ({
      ...r,
      aiSuggestion: aiTips.get(r.id) ?? null,
      // Each split carries its item's name, so a list spanning several months can label it
      splits: r.splits.map(({ lineItem, incomeItem, ...sp }) => ({ ...sp, itemName: lineItem?.name ?? incomeItem?.name ?? null })),
      suggestion: suggestions.get(r.id) ?? null,
      account: r.plaidAccountId ? accounts.get(r.plaidAccountId) ?? null : null,
    }));
  });

  // The earliest transaction date (the list offers "Load <month>" until it gets there)
  app.get("/api/transactions/oldest", async () => {
    const [row] = await db.select({ date: sql<string | null>`min(${transactions.date})` }).from(transactions);
    return { date: row?.date ?? null };
  });

  // What would this merchant be assigned to? (used by the Add Transaction form)
  app.get("/api/transactions/suggest", async (req) => {
    const q = z
      .object({
        merchant: z.string().max(200),
        date: isoDate,
        type: z.enum(["expense", "income"]).default("expense"),
        amountCents: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const s = await suggestFor(db, [{ id: 0, date: q.date, type: q.type, merchantKey: normalizeMerchant(q.merchant), amountCents: q.amountCents }]);
    return { suggestion: s.get(0) ?? null };
  });

  // Merchants you've used before, for autocomplete (newest spelling of each)
  app.get("/api/merchants", async (req) => {
    const q = z.object({ q: z.string().max(100).default(""), limit: z.coerce.number().int().min(1).max(50).default(8) }).parse(req.query);
    const term = q.q.trim().toLowerCase();
    const rows = await db.execute(sql`
      select distinct on (merchant_key) merchant, merchant_key, date
      from ${transactions}
      where merchant_key is not null and merchant_key <> '' and deleted_at is null
        ${term ? sql`and (lower(merchant) like ${"%" + term + "%"} or merchant_key like ${"%" + normalizeMerchant(term) + "%"})` : sql``}
      order by merchant_key, date desc, id desc`);
    const list = (rows.rows as { merchant: string; date: string }[]).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, q.limit);
    return list.map((r) => r.merchant);
  });

  // Accept the suggestion for one transaction, or for many at once
  async function acceptSuggestions(ids: number[]) {
    if (!ids.length) return 0;
    const rows = await db.query.transactions.findMany({
      where: and(inArray(transactions.id, ids), isNull(transactions.deletedAt)),
      with: { splits: { columns: { lineItemId: true, incomeItemId: true } } },
    });
    const unassigned = rows.filter((r) => r.splits.every((sp) => !sp.lineItemId && !sp.incomeItemId));
    const suggestions = await suggestFor(db, unassigned);
    const aiTips = await aiSuggestionsFor(db, unassigned.filter((r) => !suggestions.has(r.id)));
    let assigned = 0;
    for (const r of unassigned) {
      const s = suggestions.get(r.id) ?? aiTips.get(r.id); // history first, then the AI's guess
      if (!s) continue;
      await assignToSuggestion(db, r.id, r.amountCents, s);
      assigned++;
    }
    return assigned;
  }

  app.post("/api/transactions/:id/accept-suggestion", async (req) => {
    const { id } = idParam.parse(req.params);
    if (!(await loadTransaction(db, id))) throw notFound("Transaction");
    if ((await acceptSuggestions([id])) === 0) throw badRequest("No suggestion for this transaction");
    return loadTransaction(db, id);
  });

  // Ask the AI about these transactions (or all that need it). force: ask again.
  app.post("/api/transactions/ai-suggest", async (req) => {
    const body = z.object({ ids: z.array(z.number().int().positive()).max(1000).optional(), force: z.boolean().optional() }).parse(req.body ?? {});
    try {
      return await runAiSuggestions(db, app.ai, body);
    } catch (e) {
      if (e instanceof AiError) throw badRequest(e.message);
      throw e;
    }
  });

  // Whether AI suggestions are on (the transactions list shows Ask AI buttons when they are)
  app.get("/api/ai/status", async () => {
    const c = await app.ai.active();
    return { enabled: !!c, mode: c?.mode ?? null };
  });

  app.post("/api/transactions/accept-suggestions", async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(1000) }).parse(req.body);
    return { assigned: await acceptSuggestions(ids) };
  });

  app.get("/api/transactions/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const row = await loadTransaction(db, id);
    if (!row) throw notFound("Transaction");
    return row;
  });

  app.post("/api/transactions", async (req, reply) => {
    const input = transactionSchema.parse(req.body);
    await validateSplits(db, input);
    const id = await db.transaction(async (tx) => {
      const { splits, autoAssign: _a, ...fields } = input;
      const [row] = await tx
        .insert(transactions)
        .values({ ...fields, merchantKey: normalizeMerchant(fields.merchant) })
        .returning({ id: transactions.id });
      if (splits.length) {
        await tx.insert(transactionSplits).values(splits.map((s) => ({ ...s, transactionId: row.id })));
      }
      return row.id;
    });
    await syncTransaction(db, id);

    let autoAssigned = false;
    if (input.autoAssign && !input.splits.length) {
      const s = (await suggestFor(db, [{ id, date: input.date, type: input.type, merchantKey: normalizeMerchant(input.merchant), amountCents: input.amountCents }])).get(id);
      if (s) {
        await assignToSuggestion(db, id, input.amountCents, s);
        autoAssigned = true;
      }
    }
    if (!autoAssigned && !input.splits.length) autoSuggest(db, app.ai, req.log); // AI looks at it in the background (auto mode)
    return reply.status(201).send({ ...(await loadTransaction(db, id)), autoAssigned });
  });

  // Full replace, including splits
  app.put("/api/transactions/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const input = transactionSchema.parse(req.body);
    const existing = await loadTransaction(db, id);
    if (!existing) throw notFound("Transaction");
    if (existing.deletedAt) throw badRequest("This transaction is deleted. Restore it first.");
    if (existing.aiSuggestion && (existing.merchant !== input.merchant || existing.type !== input.type || existing.date.slice(0, 7) !== input.date.slice(0, 7))) {
      await clearAiSuggestion(db, id); // its guess was about the old details
    }
    await validateSplits(db, input);
    await db.transaction(async (tx) => {
      const { splits, autoAssign: _a, ...fields } = input;
      await tx
        .update(transactions)
        .set({ ...fields, note: fields.note ?? null, merchantKey: normalizeMerchant(fields.merchant) })
        .where(eq(transactions.id, id));
      await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, id));
      if (splits.length) {
        await tx.insert(transactionSplits).values(splits.map((s) => ({ ...s, transactionId: id })));
      }
    });
    await syncTransaction(db, id);
    return loadTransaction(db, id);
  });

  // Delete: moves it to the Deleted tab (its assignment is set aside so budgets and funds stop
  // counting it). ?permanent=true erases it for good (from the Deleted tab).
  app.delete("/api/transactions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { permanent } = z.object({ permanent: z.enum(["true", "false"]).optional() }).parse(req.query);
    const row = await loadTransaction(db, id);
    if (!row) throw notFound("Transaction");
    if (permanent === "true") {
      await db.delete(transactions).where(eq(transactions.id, id));
      return reply.status(204).send();
    }
    if (!row.deletedAt) {
      await db.transaction(async (tx) => {
        await tx
          .update(transactions)
          .set({ deletedAt: new Date(), deletedSplits: row.splits.map((s) => ({ lineItemId: s.lineItemId, incomeItemId: s.incomeItemId, amountCents: s.amountCents })) })
          .where(eq(transactions.id, id));
        await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, id));
      });
      await syncTransaction(db, id);
    }
    return reply.status(204).send();
  });

  // Bring a deleted transaction back, with its old assignment when those items still exist in its month
  app.post("/api/transactions/:id/restore", async (req) => {
    const { id } = idParam.parse(req.params);
    const row = await loadTransaction(db, id);
    if (!row) throw notFound("Transaction");
    if (!row.deletedAt) return loadTransaction(db, id);
    const saved = (row.deletedSplits ?? []).filter((s) => s.lineItemId || s.incomeItemId);
    let splits: typeof saved = [];
    if (saved.length) {
      try {
        await validateSplits(db, {
          date: row.date, merchant: row.merchant, amountCents: row.amountCents, type: row.type, note: row.note,
          splits: saved.map((s) => (s.lineItemId ? { lineItemId: s.lineItemId, amountCents: s.amountCents } : { incomeItemId: s.incomeItemId!, amountCents: s.amountCents })),
        });
        splits = saved;
      } catch {
        splits = []; // those items are gone (or moved months): comes back unassigned
      }
    }
    await db.transaction(async (tx) => {
      await tx.update(transactions).set({ deletedAt: null, deletedSplits: null }).where(eq(transactions.id, id));
      if (splits.length) await tx.insert(transactionSplits).values(splits.map((s) => ({ ...s, transactionId: id })));
    });
    await syncTransaction(db, id);
    return loadTransaction(db, id);
  });
}
