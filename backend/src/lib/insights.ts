import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, lineItems, transactions } from "../db/schema.js";
import { loadFunds } from "./budget.js";
import { monthDateRange, previousMonth } from "./calc.js";
import { monthName } from "./monthClose.js";
import { reportData, type YM } from "./reports.js";
import { parseJsonReply, type AiService } from "./ai.js";

// Monthly Insights (the email on the 2nd). The app works out every number here from your data;
// the AI only writes a short intro and one focus for next month around them, so the numbers can
// be trusted even if the wording can't.
//  - Trends: items whose spending went up three months in a row
//  - Plan these differently: items over (or well under) their plan three months running
//  - Subscriptions: monthly charges whose price went up, and new ones that started repeating
//  - Wins: items that came in under plan, savings rate vs. last month, goal progress

export interface Insights {
  month: YM;
  monthName: string;
  nextMonthName: string;
  trends: { item: string; group: string; amounts: number[] }[]; // oldest first, last = this month
  plan: { item: string; group: string; plannedCents: number; spent: number[]; suggestCents: number; direction: "more" | "less" }[];
  subscriptions: { merchant: string; cents: number; wasCents: number | null }[]; // wasCents null: new
  wins: { underItems: { item: string; leftCents: number }[]; savingsRate: number | null; lastRate: number | null; goals: { name: string; addedCents: number; pct: number | null }[] };
}

const round10 = (cents: number) => Math.round(cents / 1000) * 1000; // to the nearest $10
const ago = (m: YM, n: number) => {
  let x = m;
  for (let i = 0; i < n; i++) x = previousMonth(x.year, x.month);
  return x;
};

export async function computeInsights(db: Db, m: YM): Promise<Insights> {
  const months = [ago(m, 2), ago(m, 1), m];
  const data = await reportData(db, ago(m, 3), m);
  const keyOf = (r: { group: string; item: string }) => `${r.group}\u0000${r.item}`;
  const idx = (r: { year: number; month: number }) => months.findIndex((x) => x.year === r.year && x.month === r.month);

  // Spending and plan per item for the last three months
  const items = new Map<string, { group: string; item: string; spent: number[]; planned: (number | null)[] }>();
  const get = (r: { group: string; item: string }) => {
    const k = keyOf(r);
    if (!items.has(k)) items.set(k, { group: r.group, item: r.item, spent: [0, 0, 0], planned: [null, null, null] });
    return items.get(k)!;
  };
  for (const s of data.spending) if (idx(s) >= 0) get(s).spent[idx(s)] += s.cents;
  for (const p of data.planned) if (idx(p) >= 0) get(p).planned[idx(p)] = (get(p).planned[idx(p)] ?? 0) + p.cents;

  // Items linked to a fund save up and spend in lumps: leave them out of trends and plan advice
  const [mm] = await db.select().from(budgetMonths).where(and(eq(budgetMonths.year, m.year), eq(budgetMonths.month, m.month)));
  const fundItems = new Set(
    mm
      ? (
          await db
            .select({ group: categoryGroups.name, item: lineItems.name })
            .from(lineItems)
            .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
            .where(and(eq(categoryGroups.monthId, mm.id), isNotNull(lineItems.sinkingFundId)))
        ).map(keyOf)
      : []
  );
  const list = [...items.entries()].filter(([k]) => !fundItems.has(k)).map(([, v]) => v);

  // More money going to savings, debt or giving is good news, not a trend to warn about
  const goodGroup = /sav|invest|retire|debt|loan|giv|tith|charit|donat/i;
  const trends = list
    .filter((i) => !goodGroup.test(i.group) && !goodGroup.test(i.item))
    .filter((i) => i.spent[0] >= 2000 && i.spent[1] > i.spent[0] && i.spent[2] > i.spent[1] && i.spent[2] >= i.spent[0] * 1.2 && i.spent[2] - i.spent[0] >= 3000)
    .sort((a, b) => b.spent[2] - b.spent[0] - (a.spent[2] - a.spent[0]))
    .slice(0, 3)
    .map((i) => ({ item: i.item, group: i.group, amounts: i.spent }));

  const plan = list
    .filter((i) => i.planned.every((p) => p !== null && p > 0))
    .map((i) => {
      const planned = i.planned as number[];
      const avg = Math.round(i.spent.reduce((a, b) => a + b, 0) / 3);
      const over = i.spent.every((s, n) => s > planned[n] * 1.1);
      const under = i.spent.some((s) => s > 0) && i.spent.every((s, n) => s < planned[n] * 0.7);
      return { item: i.item, group: i.group, plannedCents: planned[2], spent: i.spent, suggestCents: Math.max(1000, round10(avg)), direction: over ? ("more" as const) : under ? ("less" as const) : null };
    })
    .filter((p): p is typeof p & { direction: "more" | "less" } => p.direction !== null && Math.abs(p.suggestCents - p.plannedCents) >= 1000)
    .sort((a, b) => Math.abs(b.suggestCents - b.plannedCents) - Math.abs(a.suggestCents - a.plannedCents))
    .slice(0, 4);

  // Subscriptions: one similar charge a month from the same merchant
  const first = monthDateRange(ago(m, 3).year, ago(m, 3).month).from;
  const last = monthDateRange(m.year, m.month).to;
  const merchant = sql<string>`coalesce(${transactions.merchantKey}, lower(${transactions.merchant}))`;
  const charges = await db
    .select({ key: merchant, name: transactions.merchant, cents: transactions.amountCents, ym: sql<string>`to_char(${transactions.date}::date, 'YYYY-MM')` })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.type, "expense"), sql`${transactions.date} between ${first} and ${last}`))
    .orderBy(transactions.date);
  const ymText = (x: YM) => `${x.year}-${String(x.month).padStart(2, "0")}`;
  const cols = [ago(m, 3), ...months].map(ymText);
  const byMerchant = new Map<string, { name: string; perMonth: Map<string, number[]> }>();
  for (const c of charges) {
    const row = byMerchant.get(c.key) ?? { name: c.name, perMonth: new Map() };
    row.name = c.name;
    row.perMonth.set(c.ym, [...(row.perMonth.get(c.ym) ?? []), c.cents]);
    byMerchant.set(c.key, row);
  }
  const subscriptions: Insights["subscriptions"] = [];
  for (const { name, perMonth } of byMerchant.values()) {
    const one = (ym: string) => (perMonth.get(ym)?.length === 1 ? perMonth.get(ym)![0] : null); // exactly one charge that month
    const [m3, m2, m1, m0] = cols.map(one);
    if (m0 === null || m1 === null) continue;
    const similar = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, b * 0.05);
    if (m2 !== null && similar(m1, m2) && m0 > m1 * 1.02 && m0 - m1 >= 50 && m0 - m1 <= m1 * 0.5) subscriptions.push({ merchant: name, cents: m0, wasCents: m1 }); // price went up
    else if (similar(m0, m1) && !perMonth.has(cols[1]) && m3 === null && m0 <= 50000) subscriptions.push({ merchant: name, cents: m0, wasCents: null }); // new: started repeating
  }

  // Wins
  const savings = (x: YM) => {
    const inc = data.income.filter((i) => i.year === x.year && i.month === x.month).reduce((t, i) => t + i.cents, 0);
    const out = data.spending.filter((s) => s.year === x.year && s.month === x.month).reduce((t, s) => t + s.cents, 0);
    return inc > 0 ? Math.round(((inc - out) / inc) * 100) : null;
  };
  const underItems = list
    .filter((i) => (i.planned[2] ?? 0) > 0 && i.spent[2] > 0 && i.spent[2] <= i.planned[2]!)
    .map((i) => ({ item: i.item, leftCents: i.planned[2]! - i.spent[2] }))
    .sort((a, b) => b.leftCents - a.leftCents)
    .slice(0, 3);
  const [now, before] = await Promise.all([loadFunds(db, m, { includeArchived: false }), loadFunds(db, ago(m, 1), { includeArchived: false })]);
  const goals = now
    .filter((f) => f.targetCents)
    .map((f) => ({ name: f.name, addedCents: f.balanceCents - (before.find((b) => b.id === f.id)?.balanceCents ?? f.startingBalanceCents), pct: f.targetCents ? Math.min(100, Math.floor((Math.max(0, f.balanceCents) / f.targetCents) * 100)) : null }))
    .filter((g) => g.addedCents > 0);

  const nm = m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
  return {
    month: m,
    monthName: monthName(m),
    nextMonthName: monthName(nm),
    trends,
    plan,
    subscriptions: subscriptions.slice(0, 5),
    wins: { underItems, savingsRate: savings(m), lastRate: savings(ago(m, 1)), goals },
  };
}

// Worth an email: something to point out, or a win to share (a month with nothing isn't sent)
export const hasInsights = (i: Insights) => i.trends.length + i.plan.length + i.subscriptions.length + i.wins.underItems.length + i.wins.goals.length > 0 || (i.wins.savingsRate ?? 0) > 0;

const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

// The facts handed to the AI (totals only, no transactions)
function factsText(i: Insights) {
  const lines = [`Month: ${i.monthName}. Next month: ${i.nextMonthName}.`];
  if (i.wins.savingsRate !== null) lines.push(`Savings rate: ${i.wins.savingsRate}%${i.wins.lastRate !== null ? ` (last month ${i.wins.lastRate}%)` : ""}.`);
  for (const t of i.trends) lines.push(`Rising 3 months in a row: ${t.item} (${t.group}) ${t.amounts.map(dollars).join(" -> ")}.`);
  for (const p of i.plan) lines.push(`${p.item}: planned ${dollars(p.plannedCents)}, spent ${p.spent.map(dollars).join(", ")} over 3 months; suggest planning ${dollars(p.suggestCents)}.`);
  for (const s of i.subscriptions) lines.push(s.wasCents ? `Subscription price up: ${s.merchant} ${dollars(s.wasCents)} -> ${dollars(s.cents)}.` : `New monthly charge: ${s.merchant} ${dollars(s.cents)}.`);
  for (const u of i.wins.underItems) lines.push(`Under plan: ${u.item}, ${dollars(u.leftCents)} left.`);
  for (const g of i.wins.goals) lines.push(`Goal ${g.name}: added ${dollars(g.addedCents)}${g.pct !== null ? `, now ${g.pct}%` : ""}.`);
  return lines.join("\n");
}

const INSIGHTS_SYSTEM = `You help someone with their monthly household budget. You get facts the app already worked out.
Reply with JSON only: {"intro": "...", "focus": "..."}
- intro: 1-2 friendly sentences on the month's story, using the facts' real numbers.
- focus: ONE concrete thing to do next month, with a dollar amount from the facts (for example a plan change or moving money to savings). One or two sentences.
No greetings, no headings, no markdown, no advice to see a professional. Never invent numbers.`;

/** The AI's intro and focus, or null if AI is off or didn't answer usefully */
export async function insightsWords(ai: AiService | undefined, i: Insights) {
  const active = ai ? await ai.active() : null;
  if (!ai || !active) return null;
  try {
    const r = await ai.chatWithFailover(active.services, INSIGHTS_SYSTEM, factsText(i), 300, active.timeoutSec * 1000);
    const j = parseJsonReply(r.text) as { intro?: unknown; focus?: unknown } | null;
    const intro = typeof j?.intro === "string" ? j.intro.trim() : "";
    const focus = typeof j?.focus === "string" ? j.focus.trim() : "";
    if (!intro && !focus) return null;
    return { intro, focus, service: r.service.name };
  } catch {
    return null;
  }
}

/** Without AI: a focus worked out from the biggest plan change, or the biggest trend */
export function plainFocus(i: Insights) {
  const p = i.plan[0];
  if (p) return `Plan ${dollars(p.suggestCents)} for ${p.item} in ${i.nextMonthName} (it's been ${p.direction === "more" ? "over" : "well under"} its ${dollars(p.plannedCents)} plan three months running).`;
  const t = i.trends[0];
  if (t) return `Keep an eye on ${t.item}: it's gone from ${dollars(t.amounts[0])} to ${dollars(t.amounts[2])} in three months.`;
  return null;
}
