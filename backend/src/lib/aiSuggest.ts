import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, incomeItems, lineItems, plaidAccounts, transactions } from "../db/schema.js";
import { AiError, parseJsonReply, type AiService } from "./ai.js";
import { suggestFor, type Suggestion } from "./suggest.js";
import { logEvent } from "./appLog.js";

// AI suggestions: for unassigned transactions that history can't place, ask the AI to pick one of
// that month's budget items. The answer is saved on the transaction (so it's asked only once) and
// shown as a purple chip; nothing is assigned until you accept it.

export interface AiRunResult {
  asked: number; // sent to the AI
  suggested: number; // got a budget item
  noMatch: number; // the AI found no good fit
  skipped: { reason: string; count: number }[];
  error?: string;
  services?: Record<string, number>; // which AI answered, and for how many
  warnings?: string[]; // services that were down (a later one answered instead)
}

const BATCH = 25; // transactions per request

type Tx = typeof transactions.$inferSelect;

function toCode(s: { lineItemId?: number; incomeItemId?: number }) {
  return s.lineItemId ? `L${s.lineItemId}` : s.incomeItemId ? `I${s.incomeItemId}` : null;
}

const SYSTEM = `You help categorize personal budget transactions.
For each transaction, choose the ONE budget item it most likely belongs to, using only the item codes provided for that month.
Rules:
- Money out (expense) goes on an "L" budget item.
- Money in (income) usually goes on an "I" income item (paychecks, deposits). Refunds or transfers back can go on the "L" item they came from.
- If nothing fits reasonably well, use null. Don't guess wildly.
- Keep each reason under 12 words.
Reply with JSON only, no other text: {"results":[{"id":<transaction id>,"item":"<code or null>","reason":"<short reason>"}]}`;

/**
 * Ask the AI about these transactions (or, with ids omitted, every unassigned one that has no
 * history suggestion and hasn't been asked yet). force: ask again even if asked before.
 */
export async function runAiSuggestions(db: Db, ai: AiService, opts: { ids?: number[]; force?: boolean } = {}): Promise<AiRunResult> {
  const result: AiRunResult = { asked: 0, suggested: 0, noMatch: 0, skipped: [] };
  const skip = (reason: string, count: number) => count && result.skipped.push({ reason, count });
  const config = await ai.active();
  if (!config) throw new AiError("AI isn't turned on. Set it up in Settings > AI.");

  // Candidates: unassigned, not deleted, not pending-only filters (pending is fine to guess)
  const rows = await db.query.transactions.findMany({
    where: and(isNull(transactions.deletedAt), opts.ids ? inArray(transactions.id, opts.ids.length ? opts.ids : [-1]) : undefined),
    with: { splits: { columns: { lineItemId: true, incomeItemId: true } } },
    orderBy: (t, { desc }) => [desc(t.date), desc(t.id)],
  });
  let pool = rows.filter((r) => r.splits.every((s) => !s.lineItemId && !s.incomeItemId));
  skip("already assigned", rows.length - pool.length);

  // History always wins: never ask the AI about a merchant you've assigned before
  const history = await suggestFor(db, pool, { ignoreFastTrack: true });
  skip("already have a suggestion from your history", pool.filter((r) => history.has(r.id)).length);
  pool = pool.filter((r) => !history.has(r.id));

  if (!opts.force) {
    const before = pool.length;
    pool = pool.filter((r) => !r.aiSuggestion);
    skip("AI already looked at them", before - pool.length);
  }

  // Each month's items (a transaction can only go on items in its own month)
  const monthKeys = [...new Set(pool.map((r) => r.date.slice(0, 7)))];
  const months = monthKeys.length
    ? await db
        .select({ id: budgetMonths.id, key: sql<string>`${budgetMonths.year} || '-' || lpad(${budgetMonths.month}::text, 2, '0')` })
        .from(budgetMonths)
        .where(inArray(sql`${budgetMonths.year} || '-' || lpad(${budgetMonths.month}::text, 2, '0')`, monthKeys))
    : [];
  const monthId = new Map(months.map((m) => [m.key, m.id]));
  const before = pool.length;
  pool = pool.filter((r) => monthId.has(r.date.slice(0, 7)));
  skip("in a month with no budget yet", before - pool.length);

  const capped = pool.slice(0, config.maxPerRun);
  skip(`over the limit of ${config.maxPerRun} per run (they'll be asked next time)`, pool.length - capped.length);
  if (!capped.length) return result;

  const ids = [...monthId.values()];
  const lines = await db
    .select({ id: lineItems.id, name: lineItems.name, group: categoryGroups.name, monthId: categoryGroups.monthId, sort: categoryGroups.sortOrder, isort: lineItems.sortOrder })
    .from(lineItems)
    .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
    .where(inArray(categoryGroups.monthId, ids));
  const income = await db.select({ id: incomeItems.id, name: incomeItems.name, monthId: incomeItems.monthId }).from(incomeItems).where(inArray(incomeItems.monthId, ids));
  const accountIds = [...new Set(capped.flatMap((r) => (r.plaidAccountId ? [r.plaidAccountId] : [])))];
  const accounts = accountIds.length ? new Map((await db.select().from(plaidAccounts).where(inArray(plaidAccounts.accountId, accountIds))).map((a) => [a.accountId, a])) : new Map();

  // One request per month per batch, so each prompt lists just that month's items
  const byMonth = new Map<string, Tx[]>();
  for (const r of capped) byMonth.set(r.date.slice(0, 7), [...(byMonth.get(r.date.slice(0, 7)) ?? []), r]);

  for (const [key, txs] of byMonth) {
    const mId = monthId.get(key)!;
    const mLines = lines.filter((l) => l.monthId === mId).sort((a, b) => a.sort - b.sort || a.isort - b.isort);
    const mIncome = income.filter((i) => i.monthId === mId);
    const valid = new Set([...mLines.map((l) => `L${l.id}`), ...mIncome.map((i) => `I${i.id}`)]);
    const itemList = [...mIncome.map((i) => `I${i.id}: Income > ${i.name}`), ...mLines.map((l) => `L${l.id}: ${l.group} > ${l.name}`)].join("\n");

    for (let i = 0; i < txs.length; i += BATCH) {
      const batch = txs.slice(i, i + BATCH);
      // Ask the services in order. Whatever the one that answers can't place (and anything it
      // skipped) goes to the services after it when "ask the next AI" is on.
      let pending = batch;
      let from = 0;
      const now = new Date().toISOString();
      while (pending.length && from < config.services.length) {
        const txList = pending
          .map((t) => {
            const acct = t.plaidAccountId ? accounts.get(t.plaidAccountId) : null;
            return JSON.stringify({
              id: t.id,
              date: t.date,
              merchant: t.merchant,
              amount: (t.amountCents / 100).toFixed(2),
              direction: t.type === "income" ? "money in" : "money out",
              ...(acct ? { account: `${acct.name}${acct.subtype ? ` (${acct.subtype})` : ""}` } : {}),
              ...(t.note ? { note: t.note.slice(0, 200) } : {}),
            });
          })
          .join("\n");
        const user = `Budget items for ${key}:\n${itemList}\n\nTransactions:\n${txList}`;
        let answer;
        try {
          answer = await ai.chatWithFailover(config.services.slice(from), SYSTEM, user, 150 + pending.length * 60, config.timeoutSec * 1000);
        } catch (e) {
          // Nobody (left) answered. If an earlier service already looked, its "no fit" stands.
          if (from === 0) {
            result.error = (e as Error).message;
            return result; // stop: the next run tries again (nothing was saved for these)
          }
          break;
        }
        if (answer.failures.length) result.warnings = [...(result.warnings ?? []), ...answer.failures];
        const sv = answer.service;
        const usedIndex = from + answer.index;
        const isLast = usedIndex === config.services.length - 1;
        if (from === 0) result.asked += pending.length;
        const parsed = parseJsonReply(answer.text) as { results?: { id: number; item: string | null; reason?: string }[] } | { id: number }[] | null;
        if (!parsed)
          await logEvent(db, { category: "ai", level: "warning", source: sv.name, event: `${sv.name} answered, but not in a form the app could use`, detail: `It said: ${answer.text.slice(0, 300)}` });
        const answers = Array.isArray(parsed) ? (parsed as { id: number; item: string | null; reason?: string }[]) : parsed?.results ?? [];
        const left: Tx[] = [];
        for (const t of pending) {
          const a = answers.find((x) => Number(x.id) === t.id);
          if (!a) {
            if (config.askNextOnNoMatch && !isLast) left.push(t);
            continue; // not answered: ask again next time
          }
          const code = typeof a.item === "string" ? a.item.trim().toUpperCase() : null;
          const reason = typeof a.reason === "string" ? a.reason.slice(0, 160) : undefined;
          // Expenses can't go on income items; only codes from this month count
          const ok = code && valid.has(code) && !(t.type === "expense" && code.startsWith("I"));
          if (!ok && config.askNextOnNoMatch && !isLast) {
            left.push(t); // let the next AI have a look
            continue;
          }
          const by = { model: sv.model, service: sv.name };
          const value = ok
            ? { ...(code!.startsWith("L") ? { lineItemId: Number(code!.slice(1)) } : { incomeItemId: Number(code!.slice(1)) }), reason, ...by, at: now }
            : { none: true, reason: reason ?? "No good fit", ...by, at: now };
          await db.update(transactions).set({ aiSuggestion: value }).where(eq(transactions.id, t.id));
          result.services = { ...result.services, [sv.name]: (result.services?.[sv.name] ?? 0) + 1 };
          if (ok) result.suggested++;
          else result.noMatch++;
        }
        pending = left;
        from = usedIndex + 1;
      }
      // Passed along but no later service could answer: they had no fit from the earlier one
      for (const t of pending) {
        await db.update(transactions).set({ aiSuggestion: { none: true, reason: "No good fit", model: "", at: now } }).where(eq(transactions.id, t.id));
        result.noMatch++;
      }
    }
  }
  return result;
}

// For lists: the AI's suggestion as a chip, when it still applies (still unassigned, no history
// suggestion, item still exists). Returns item names.
export async function aiSuggestionsFor(db: Db, rows: { id: number; aiSuggestion: Tx["aiSuggestion"] }[]) {
  const out = new Map<number, Suggestion & { reason?: string; model: string; service?: string }>();
  const lineIds = rows.flatMap((r) => (r.aiSuggestion?.lineItemId ? [r.aiSuggestion.lineItemId] : []));
  const incomeIds = rows.flatMap((r) => (r.aiSuggestion?.incomeItemId ? [r.aiSuggestion.incomeItemId] : []));
  const lineNames = lineIds.length
    ? new Map((await db.select({ id: lineItems.id, name: lineItems.name, group: categoryGroups.name }).from(lineItems).innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id)).where(inArray(lineItems.id, lineIds))).map((l) => [l.id, l]))
    : new Map();
  const incomeNames = incomeIds.length ? new Map((await db.select({ id: incomeItems.id, name: incomeItems.name }).from(incomeItems).where(inArray(incomeItems.id, incomeIds))).map((i) => [i.id, i])) : new Map();
  for (const r of rows) {
    const s = r.aiSuggestion;
    if (!s || s.none) continue;
    if (s.lineItemId && lineNames.has(s.lineItemId)) {
      const l = lineNames.get(s.lineItemId);
      out.set(r.id, { lineItemId: l.id, itemName: l.name, groupName: l.group, reason: s.reason, model: s.model, service: s.service });
    } else if (s.incomeItemId && incomeNames.has(s.incomeItemId)) {
      out.set(r.id, { incomeItemId: s.incomeItemId, itemName: incomeNames.get(s.incomeItemId).name, groupName: "Income", reason: s.reason, model: s.model, service: s.service });
    }
  }
  return out;
}

// Clear the AI's answer (e.g. the merchant changed, so it should look again)
export async function clearAiSuggestion(db: Db, id: number) {
  await db.update(transactions).set({ aiSuggestion: null }).where(eq(transactions.id, id));
}

// Kick off an automatic run without making anyone wait for it
let autoRunning = false;
export function autoSuggest(db: Db, ai: AiService, log?: { warn: (m: string) => void }) {
  if (autoRunning) return;
  autoRunning = true;
  void (async () => {
    try {
      const c = await ai.active();
      if (!c || c.mode !== "auto") return;
      const r = await runAiSuggestions(db, ai);
      if (r.error) log?.warn(`AI suggestions: ${r.error}`);
      if (r.error || r.asked)
        await logEvent(db, {
          category: "schedule",
          level: r.error ? "error" : "info",
          source: "AI suggestions",
          event: r.error ? "Automatic AI suggestions didn't run" : `AI looked at ${r.asked} new transaction${r.asked === 1 ? "" : "s"}`,
          detail: r.error ?? `${r.suggested} suggested`,
        });
    } catch (e) {
      log?.warn(`AI suggestions: ${(e as Error).message}`);
      await logEvent(db, { category: "schedule", level: "error", source: "AI suggestions", event: "Automatic AI suggestions didn't run", detail: (e as Error).message });
    } finally {
      autoRunning = false;
    }
  })();
}
