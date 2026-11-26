import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings, budgetMonths, notificationLog, plaidAccounts, plaidItems, sinkingFunds, transactions, transactionSplits, users } from "../db/schema.js";
import type { EmailKind, MailService } from "./mail.js";
import { renderEmail, type EmailContent } from "./emailLayout.js";
import { computeInsights, hasInsights, insightsWords, plainFocus } from "./insights.js";
import { bankAttention, monthlyInsights, goalBehind, goalMilestone, largePurchase, monthCloseReminder, monthlySummary, newSignIn, nextMonthSetup, nudge, overBudget, weeklyCheckIn } from "./emails.js";
import { notTransferSplit, notTransferTransaction } from "./transfers.js";
import { loadBudget, loadFunds } from "./budget.js";
import { goalPlan } from "./goals.js";
import { isOn } from "./features.js";
import { aiSummary, reportData, summaryBullets, unusualSpending } from "./reports.js";
import { describeDevice } from "./sessions.js";
import type { AiService } from "./ai.js";
import { closeAvailable, monthName } from "./monthClose.js";
import { getBudgetPrefs } from "./prefs.js";
import { monthIndex, nextMonth, previousMonth } from "./calc.js";

// Email notifications (Settings › Notifications). Checked every hour; each one is logged in
// notification_log under a key, so it's sent once. Morning ones wait until 8am (server time).
//  - Wrap-Up reminder: when a month's Wrap Up button appears (once per month)
//  - Nudge: you haven't used the app for X days and transactions are waiting (at most every X days)
//  - Monthly summary: on the 1st, last month's income, spending, groups and anything unusual
//  - Monthly insights: on the 2nd, trends, plans that keep missing, subscription changes, wins and
//    one focus for next month (numbers from the app, wording from AI when it's on)
//  - Bank needs attention: a bank connection needs signing in again or stopped updating
//  - Over budget: an item spends more than planned this month (once per item per month)
//  - Weekly check-in: on the day you pick, the week's spending and what's left
//  - Goal milestones: a goal reaches 25/50/75/100% (funds: their target), or falls behind
//  - Large purchase: one purchase over an amount you pick
//  - Next month isn't set up: a few days before a month starts with no budget for it
//  - New sign-in: right away, when a browser or device signs in for the first time

export interface NotificationPrefs {
  enabled: boolean;
  monthCloseReminder: boolean;
  nudge: boolean;
  nudgeDays: number;
  monthlySummary: boolean;
  monthlySummaryAi: boolean; // add the AI's few lines when AI is on
  monthlyInsights: boolean;
  bankAttention: boolean;
  overBudget: boolean;
  weekly: boolean;
  weeklyDay: number; // 0 = Sunday
  goalMilestones: boolean;
  largePurchase: boolean;
  largePurchaseCents: number;
  nextMonth: boolean;
  nextMonthDays: number;
  newSignIn: boolean;
}
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  monthCloseReminder: true,
  nudge: true,
  nudgeDays: 7,
  monthlySummary: true,
  monthlySummaryAi: true,
  monthlyInsights: true,
  bankAttention: true,
  overBudget: true,
  weekly: true,
  weeklyDay: 0,
  goalMilestones: true,
  largePurchase: true,
  largePurchaseCents: 50000,
  nextMonth: true,
  nextMonthDays: 3,
  newSignIn: true,
};

// Each person has their own switches. The owner's are in app_settings "notifications" (as before
// shared access); everyone else's are on their user row, and start with emails off.
const isOwnerId = async (db: Db, userId?: number) => {
  if (userId === undefined) return true;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return !u || u.role === "owner";
};

export async function getNotificationPrefs(db: Db, userId?: number): Promise<NotificationPrefs> {
  if (!(await isOwnerId(db, userId))) {
    const [u] = await db.select({ p: users.notificationPrefs }).from(users).where(eq(users.id, userId!));
    return { ...DEFAULT_NOTIFICATION_PREFS, ...((u?.p as Partial<NotificationPrefs>) ?? {}) };
  }
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "notifications"));
  const saved = { ...((row?.value as Partial<NotificationPrefs>) ?? {}) };
  // Saved before the monthly summary existed (its switch was a locked placeholder): use the new default
  if (!("bankAttention" in saved)) delete saved.monthlySummary;
  return { ...DEFAULT_NOTIFICATION_PREFS, ...saved };
}

export async function saveNotificationPrefs(db: Db, changes: Partial<NotificationPrefs>, userId?: number) {
  const value = { ...(await getNotificationPrefs(db, userId)), ...changes };
  if (!(await isOwnerId(db, userId))) {
    await db.update(users).set({ notificationPrefs: value }).where(eq(users.id, userId!));
    return value;
  }
  await db
    .insert(appSettings)
    .values({ key: "notifications", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return value;
}

const recipientCols = { id: users.id, role: users.role, email: users.email, lastActiveAt: users.lastActiveAt, createdAt: users.createdAt, name: users.displayName, theme: users.theme };

// Who a notification goes to: that person, or the owner
export async function recipient(db: Db, userId?: number) {
  const [u] =
    userId !== undefined
      ? await db.select(recipientCols).from(users).where(eq(users.id, userId))
      : await db.select(recipientCols).from(users).orderBy(sql`${users.role} <> 'owner'`, asc(users.id)).limit(1);
  return u ?? null;
}

// notification_log keys: the owner's as before ("summary:2026-10"), everyone else's start "u<id>:"
const keyPrefix = (u: { id: number; role: string }) => (u.role === "owner" ? "" : `u${u.id}:`);

const DAY = 24 * 60 * 60 * 1000;

const uncategorized = and(
  isNull(transactions.deletedAt),
  eq(transactions.pending, false),
  sql`not exists (select 1 from ${transactionSplits} s where s.transaction_id = ${transactions.id} and (s.line_item_id is not null or s.income_item_id is not null))`
);

async function uncategorizedCount(db: Db) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(uncategorized);
  return n;
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

async function waitingExamples(db: Db) {
  const rows = await db.select().from(transactions).where(uncategorized).orderBy(desc(transactions.date), desc(transactions.id)).limit(5);
  return rows.map((r) => ({ merchant: r.merchant, amount: `${r.type === "income" ? "+" : ""}${money(r.amountCents)}`, date: shortDate(r.date) }));
}

// ----- What each notification says (used for the real emails and for samples) -----

async function monthCloseContent(db: Db, m: typeof budgetMonths.$inferSelect, over: boolean): Promise<EmailContent> {
  const b = await loadBudget(db, m.id);
  return monthCloseReminder({ monthName: monthName(m), over, plannedCents: b?.totals.plannedCents ?? null, spentCents: b?.totals.spentCents ?? null });
}

async function nudgeContent(db: Db, waiting: number, days: number): Promise<EmailContent> {
  return nudge({ waiting, days, examples: await waitingExamples(db) });
}

export const NOTIFICATION_KINDS = ["month-close", "nudge", "summary", "insights", "bank", "over-budget", "weekly", "goal", "large-purchase", "next-month", "sign-in"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_NAMES: Record<NotificationKind, string> = {
  "month-close": "the Wrap-Up reminder",
  nudge: "the transactions-waiting nudge",
  summary: "the monthly summary",
  insights: "the monthly insights email",
  bank: "the bank-needs-attention alert",
  "over-budget": "the over-budget alert",
  weekly: "the weekly check-in",
  goal: "the goal milestone email",
  "large-purchase": "the large-purchase alert",
  "next-month": "the next-month reminder",
  "sign-in": "the new sign-in alert",
};

/** A sample of a notification with your real numbers where there are some (Settings › Send a sample). */
export async function sampleNotification(db: Db, kind: NotificationKind, now = new Date(), ai?: AiService, userId?: number): Promise<EmailContent> {
  if (kind !== "month-close" && kind !== "nudge") return sampleOther(db, kind, now, ai, userId);
  if (kind === "month-close") {
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    const [m] = await db.select().from(budgetMonths).where(and(eq(budgetMonths.year, cur.year), eq(budgetMonths.month, cur.month)));
    if (m) return monthCloseContent(db, m, false);
    return monthCloseReminder({ monthName: monthName(cur), over: false, plannedCents: 512000, spentCents: 468350 });
  }
  const user = await recipient(db, userId);
  const days = Math.max(1, Math.floor((now.getTime() - (user?.lastActiveAt ?? user?.createdAt ?? now).getTime()) / DAY));
  const waiting = await uncategorizedCount(db);
  if (waiting > 0) return nudgeContent(db, waiting, days);
  return nudge({
    waiting: 3,
    days: 7,
    examples: [
      { merchant: "Grocery store", amount: "$84.12", date: "Oct 24" },
      { merchant: "Coffee shop", amount: "$6.50", date: "Oct 23" },
      { merchant: "Gas station", amount: "$41.07", date: "Oct 22" },
    ],
  });
}

// ----- The newer notifications: what each one says, from your data -----

const ymOf = (d: Date) => ({ year: d.getFullYear(), month: d.getMonth() + 1 });
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymKey = (m: { year: number; month: number }) => `${m.year}-${pad2(m.month)}`;
const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const MORNING = 8; // morning emails wait until 8am (server time)

async function findMonth(db: Db, ym: { year: number; month: number }) {
  const [m] = await db.select().from(budgetMonths).where(and(eq(budgetMonths.year, ym.year), eq(budgetMonths.month, ym.month)));
  return m ?? null;
}

// Items over plan in a month. Items linked to a fund are left out (their extra comes from the fund).
async function overItems(db: Db, monthId: number) {
  const b = await loadBudget(db, monthId);
  if (!b) return [];
  return b.groups.flatMap((g) => g.items.filter((i) => !i.sinkingFund && !i.isTransfer && i.spentCents > i.plannedCents && i.spentCents > 0).map((i) => ({ id: i.id, item: i.name, group: g.name, spentCents: i.spentCents, plannedCents: i.plannedCents })));
}

async function summaryContent(db: Db, ym: { year: number; month: number }, ai: AiService | undefined, withAi: boolean): Promise<EmailContent | null> {
  const from = { year: ym.year, month: ym.month };
  for (let i = 0; i < 3; i++) Object.assign(from, previousMonth(from.year, from.month)); // 3 months before, for "usual"
  const data = await reportData(db, from, ym);
  const mine = <T extends { year: number; month: number }>(rows: T[]) => rows.filter((r) => r.year === ym.year && r.month === ym.month);
  const spending = mine(data.spending);
  const income = mine(data.income);
  if (!spending.length && !income.length) return null;
  const groups = new Map<string, { name: string; spentCents: number; plannedCents: number }>();
  for (const sRow of spending) {
    const g = groups.get(sRow.group) ?? { name: sRow.group, spentCents: 0, plannedCents: 0 };
    g.spentCents += sRow.cents;
    groups.set(sRow.group, g);
  }
  for (const pRow of mine(data.planned)) {
    const g = groups.get(pRow.group);
    if (g) g.plannedCents += pRow.cents;
  }
  let aiBullets: string[] | null = null;
  let aiService: string | null = null;
  if (withAi && ai) {
    const active = await ai.active();
    if (active) {
      try {
        const monthOnly = await reportData(db, ym, ym);
        const r = await aiSummary(ai, active.services, active.timeoutSec, monthOnly);
        aiBullets = summaryBullets(r.text).slice(0, 5);
        aiService = r.service;
      } catch {
        // the summary goes out without the AI's lines
      }
    }
  }
  return monthlySummary({
    monthName: monthName(ym),
    incomeCents: income.reduce((t, r) => t + r.cents, 0),
    spentCents: spending.reduce((t, r) => t + r.cents, 0),
    plannedCents: mine(data.planned).reduce((t, r) => t + r.cents, 0),
    groups: [...groups.values()].sort((a, b) => b.spentCents - a.spentCents).slice(0, 6),
    unusual: unusualSpending(data).slice(0, 4),
    aiBullets,
    aiService,
  });
}

async function insightsContent(db: Db, ym: { year: number; month: number }, ai: AiService | undefined): Promise<EmailContent | null> {
  const i = await computeInsights(db, ym);
  if (!hasInsights(i)) return null;
  const words = await insightsWords(ai, i);
  return monthlyInsights({ ...i, intro: words?.intro ?? null, focus: words?.focus || plainFocus(i), aiService: words?.service ?? null });
}

async function weeklyContent(db: Db, now: Date): Promise<EmailContent> {
  const weekAgo = new Date(now.getTime() - 6 * DAY);
  const rows = await db
    .select({
      merchant: transactions.merchant,
      cents: sql<string>`sum(case when ${transactions.type} = 'income' then -${transactionSplits.amountCents} else ${transactionSplits.amountCents} end)`,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .where(and(isNull(transactions.deletedAt), sql`${transactionSplits.lineItemId} is not null`, notTransferSplit, sql`${transactions.date} between ${isoDay(weekAgo)} and ${isoDay(now)}`))
    .groupBy(transactions.merchant);
  const merchants = rows.map((r) => ({ name: r.merchant, cents: Number(r.cents) })).filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const cur = ymOf(now);
  const m = await findMonth(db, cur);
  const b = m ? await loadBudget(db, m.id) : null;
  const items = b ? b.groups.flatMap((g) => g.items.filter((i) => !i.sinkingFund && !i.isTransfer)) : [];
  // Money moved between your own accounts isn't spending
  const transferSpent = b ? b.groups.flatMap((g) => g.items.filter((i) => i.isTransfer)).reduce((t, i) => t + i.spentCents, 0) : 0;
  const daysIn = new Date(cur.year, cur.month, 0).getDate();
  return weeklyCheckIn({
    weekSpentCents: merchants.reduce((t, r) => t + r.cents, 0),
    topMerchants: merchants.slice(0, 3),
    plannedCents: b?.totals.plannedCents ?? 0,
    leftCents: b ? b.totals.plannedCents - (b.totals.spentCents - transferSpent) : 0,
    daysLeft: daysIn - now.getDate() + 1,
    monthName: monthName(cur),
    over: items.filter((i) => i.spentCents > i.plannedCents && i.spentCents > 0).sort((a, z) => z.spentCents - z.plannedCents - (a.spentCents - a.plannedCents)).slice(0, 5).map((i) => ({ item: i.name, overCents: i.spentCents - i.plannedCents })),
    close: items.filter((i) => i.plannedCents > 0 && i.spentCents > 0 && i.spentCents <= i.plannedCents && i.plannedCents - i.spentCents <= i.plannedCents * 0.1).slice(0, 5).map((i) => ({ item: i.name, leftCents: i.plannedCents - i.spentCents })),
    waiting: await uncategorizedCount(db),
  });
}

// Goals and funds with a target, as of this month
async function targetFunds(db: Db, now: Date) {
  const funds = await loadFunds(db, ymOf(now), { includeArchived: false });
  return funds.filter((f) => f.targetCents && f.targetCents > 0).map((f) => ({ ...f, pct: Math.floor((Math.max(0, f.balanceCents) / f.targetCents!) * 100) }));
}

// Behind schedule: a goal with a date that's under 90% of where a steady pace would have it
function behind(f: Awaited<ReturnType<typeof targetFunds>>[number], now: Date) {
  if (f.kind !== "goal" || !f.targetDate || f.goalReached) return null;
  const start = monthIndex(f.createdAt.getFullYear(), f.createdAt.getMonth() + 1);
  const end = monthIndex(Number(f.targetDate.slice(0, 4)), Number(f.targetDate.slice(5, 7)));
  const at = monthIndex(now.getFullYear(), now.getMonth() + 1);
  if (at - start < 1 || end <= start) return null;
  const expected = Math.round(f.startingBalanceCents + ((f.targetCents! - f.startingBalanceCents) * Math.min(1, (at - start) / (end - start))));
  if (f.balanceCents >= expected * 0.9) return null;
  const plan = goalPlan(f, now);
  return { expected, monthly: plan?.monthlyCents ?? 0 };
}

async function largeRecent(db: Db, now: Date, threshold: number) {
  return db
    .select({ id: transactions.id, merchant: transactions.merchant, cents: transactions.amountCents, date: transactions.date, account: plaidAccounts.name, mask: plaidAccounts.mask })
    .from(transactions)
    .leftJoin(plaidAccounts, eq(transactions.plaidAccountId, plaidAccounts.accountId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.type, "expense"),
        notTransferTransaction,
        sql`${transactions.amountCents} >= ${threshold}`,
        sql`${transactions.createdAt} >= ${new Date(now.getTime() - 2 * DAY)}`, // just came in
        sql`${transactions.date} >= ${isoDay(new Date(now.getTime() - 7 * DAY))}` // and recent (not old history)
      )
    )
    .orderBy(desc(transactions.amountCents));
}
const largeRow = (r: { merchant: string; cents: number; date: string; account: string | null; mask: string | null }) => ({ merchant: r.merchant, cents: r.cents, date: shortDate(r.date), account: r.account ? `${r.account}${r.mask ? ` ••${r.mask}` : ""}` : null });

// Samples of the newer notifications: your data where there is some, otherwise an example
async function sampleOther(db: Db, kind: Exclude<NotificationKind, "month-close" | "nudge">, now: Date, ai?: AiService, userId?: number): Promise<EmailContent> {
  const prefs = await getNotificationPrefs(db, userId);
  const cur = ymOf(now);
  switch (kind) {
    case "summary": {
      const real = (await summaryContent(db, previousMonth(cur.year, cur.month), ai, prefs.monthlySummaryAi)) ?? (await summaryContent(db, cur, ai, prefs.monthlySummaryAi));
      return (
        real ??
        monthlySummary({ monthName: monthName(previousMonth(cur.year, cur.month)), incomeCents: 640000, spentCents: 571250, plannedCents: 600000, groups: [{ name: "Home", spentCents: 210000, plannedCents: 210000 }, { name: "Food", spentCents: 98000, plannedCents: 85000 }], unusual: [] })
      );
    }
    case "insights": {
      const last = previousMonth(cur.year, cur.month);
      const real = (await findMonth(db, last)) ? await insightsContent(db, last, ai) : null;
      return (
        real ??
        monthlyInsights({
          monthName: monthName(last),
          nextMonthName: monthName(cur),
          intro: "Spending was steady overall, but eating out keeps climbing.",
          focus: "Plan $300 for Dining Out and move the $50 it saves to your emergency fund.",
          trends: [{ item: "Dining Out", group: "Food", amounts: [18000, 24000, 31000] }],
          plan: [{ item: "Groceries", plannedCents: 60000, spent: [71200, 69800, 73000], suggestCents: 71000, direction: "more" }],
          subscriptions: [{ merchant: "Streaming service", cents: 1799, wasCents: 1549 }],
          wins: { underItems: [{ item: "Fuel", leftCents: 4200 }], savingsRate: 14, lastRate: 9, goals: [] },
        })
      );
    }
    case "bank": {
      const [item] = await db.select().from(plaidItems).orderBy(asc(plaidItems.id)).limit(1);
      return bankAttention({ bank: item?.institutionName ?? "Your bank", status: "login_required", message: null, lastSynced: item?.lastSyncedAt ? item.lastSyncedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : null });
    }
    case "over-budget": {
      const m = await findMonth(db, cur);
      const over = m ? await overItems(db, m.id) : [];
      return overBudget({ monthName: monthName(cur), items: over.length ? over.slice(0, 5) : [{ item: "Dining Out", group: "Food", spentCents: 23450, plannedCents: 20000 }] });
    }
    case "weekly":
      return weeklyContent(db, now);
    case "goal": {
      const funds = await targetFunds(db, now);
      const f = funds.find((x) => x.kind === "goal") ?? funds[0];
      if (!f) return goalMilestone({ name: "Emergency Fund", pct: 50, balanceCents: 250000, targetCents: 500000, targetDate: null, kind: "goal" });
      const late = behind(f, now);
      if (late) return goalBehind({ name: f.name, balanceCents: f.balanceCents, expectedCents: late.expected, targetCents: f.targetCents!, targetDate: longDate(f.targetDate!), monthlyCents: late.monthly });
      const pct = f.kind === "goal" ? Math.max(25, Math.min(100, Math.floor(f.pct / 25) * 25)) : 100;
      return goalMilestone({ name: f.name, pct, balanceCents: f.balanceCents, targetCents: f.targetCents!, targetDate: f.targetDate ? longDate(f.targetDate) : null, kind: f.kind });
    }
    case "large-purchase": {
      const [biggest] = await db
        .select({ merchant: transactions.merchant, cents: transactions.amountCents, date: transactions.date, account: plaidAccounts.name, mask: plaidAccounts.mask })
        .from(transactions)
        .leftJoin(plaidAccounts, eq(transactions.plaidAccountId, plaidAccounts.accountId))
        .where(and(isNull(transactions.deletedAt), eq(transactions.type, "expense"), sql`${transactions.amountCents} >= ${prefs.largePurchaseCents}`))
        .orderBy(desc(transactions.date))
        .limit(1);
      return largePurchase({ thresholdCents: prefs.largePurchaseCents, items: [biggest ? largeRow(biggest) : { merchant: "Furniture store", cents: prefs.largePurchaseCents + 12999, date: shortDate(isoDay(now)), account: null }] });
    }
    case "next-month": {
      const daysIn = new Date(cur.year, cur.month, 0).getDate();
      return nextMonthSetup({ monthName: monthName(nextMonth(cur.year, cur.month)), startsIn: Math.max(1, daysIn - now.getDate() + 1) });
    }
    case "sign-in":
      return newSignIn({ device: "Safari on iPhone", ip: "203.0.113.24", when: now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), how: "password" });
  }
}

/** Branded email for the account's theme and the app's address */
export async function renderForRecipient(db: Db, mail: MailService, content: EmailContent, test?: string, userId?: number) {
  const user = await recipient(db, userId);
  const active = await mail.active();
  return renderEmail(content, { theme: user?.theme, appUrl: active?.config.appUrl ?? null, test: test ? { what: test } : null });
}

export interface NotificationResult {
  sent: { key: string; kind: string; to: string; subject: string }[];
  skipped?: string;
}

/** Send whatever is due. Safe to call often: each notification goes out once. */
export async function runNotifications(db: Db, mail: MailService, now = new Date(), ai?: AiService): Promise<NotificationResult> {
  // Everyone whose notifications are on, the owner first. Each person gets their own emails.
  const people = await db.select(recipientCols).from(users).orderBy(sql`${users.role} <> 'owner'`, asc(users.id));
  const on: { user: (typeof people)[number]; prefs: NotificationPrefs }[] = [];
  for (const u of people) {
    const prefs = await getNotificationPrefs(db, u.id);
    if (prefs.enabled) on.push({ user: u, prefs });
  }
  if (!on.length) return { sent: [], skipped: "notifications are off" };
  const active = await mail.active();
  if (!active) return { sent: [], skipped: "email isn't set up" };
  const ready = on.filter((p) => p.user.email);
  if (!ready.length) return { sent: [], skipped: "no email address on your profile" };
  const sent: NotificationResult["sent"] = [];
  const errors: Error[] = [];
  for (const p of ready) {
    try {
      sent.push(...(await runFor(db, mail, now, ai, active.config.appUrl ?? null, p.user as Recipient, p.prefs)));
    } catch (e) {
      errors.push(e as Error);
    }
  }
  if (errors.length) throw errors[0];
  return { sent };
}

type Recipient = { id: number; role: string; email: string; lastActiveAt: Date | null; createdAt: Date; name: string | null; theme: string | null };

// One person's notifications
async function runFor(db: Db, mail: MailService, now: Date, ai: AiService | undefined, appUrl: string | null, user: Recipient, prefs: NotificationPrefs) {
  const sent: NotificationResult["sent"] = [];
  const p = keyPrefix(user);

  const send = async (bareKey: string, kind: string, content: EmailContent) => {
    const key = p + bareKey;
    // Claim the key first, so two runs can't both send it
    const claimed = await db.insert(notificationLog).values({ key, kind, sentTo: user.email!, sentAt: now }).onConflictDoNothing().returning();
    if (!claimed.length) return;
    try {
      const email = renderEmail(content, { theme: user.theme, appUrl });
      await mail.sendRendered(user.email!, email, kind as EmailKind);
      sent.push({ key, kind, to: user.email!, subject: email.subject });
    } catch (e) {
      await db.delete(notificationLog).where(eq(notificationLog.key, key)); // try again next time
      throw e;
    }
  };
  const logged = async (key: string) => (await db.select({ key: notificationLog.key }).from(notificationLog).where(eq(notificationLog.key, p + key))).length > 0;
  // One email covering several keys (over-budget items, goal steps, purchases): all claimed, or none
  const sendMany = async (bareKeys: string[], kind: string, content: EmailContent) => {
    const keys = bareKeys.map((k) => p + k);
    const claimed = await db.insert(notificationLog).values(keys.map((key) => ({ key, kind, sentTo: user.email!, sentAt: now }))).onConflictDoNothing().returning();
    if (!claimed.length) return;
    try {
      const email = renderEmail(content, { theme: user.theme, appUrl });
      await mail.sendRendered(user.email!, email, kind as EmailKind);
      sent.push({ key: keys[0], kind, to: user.email!, subject: email.subject });
    } catch (e) {
      await db.delete(notificationLog).where(inArray(notificationLog.key, keys));
      throw e;
    }
  };

  // Each kind runs on its own, so one failing (a bad email, say) doesn't stop the others
  const errors: Error[] = [];
  const section = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e as Error);
    }
  };
  const cur = ymOf(now);
  const morning = now.getHours() >= MORNING;

  // Month Close reminder: this month (once its button shows) or last month if it's still open
  const budget = await getBudgetPrefs(db);
  if (prefs.monthCloseReminder && budget.monthCloseEnabled) await section(async () => {
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    for (const ym of [previousMonth(cur.year, cur.month), cur]) {
      const [m] = await db.select().from(budgetMonths).where(and(eq(budgetMonths.year, ym.year), eq(budgetMonths.month, ym.month)));
      if (!m || m.closedAt || !closeAvailable(m, now, budget.monthCloseDays)) continue;
      const over = monthIndex(ym.year, ym.month) < monthIndex(cur.year, cur.month);
      await send(`month-close:${ym.year}-${String(ym.month).padStart(2, "0")}`, "month-close", await monthCloseContent(db, m, over));
    }
  });

  // Nudge: away for X days with transactions waiting
  if (prefs.nudge) await section(async () => {
    const last = (user.lastActiveAt ?? user.createdAt).getTime();
    const away = now.getTime() - last >= prefs.nudgeDays * DAY;
    if (away) {
      const [lastNudge] = await db.select().from(notificationLog).where(sql`${notificationLog.key} like ${`${p}nudge:%`}`).orderBy(desc(notificationLog.sentAt)).limit(1);
      const nudgedRecently = lastNudge && now.getTime() - lastNudge.sentAt.getTime() < prefs.nudgeDays * DAY && lastNudge.sentAt.getTime() > last;
      const waiting = await uncategorizedCount(db);
      if (!nudgedRecently && waiting > 0) {
        const days = Math.floor((now.getTime() - last) / DAY);
        await send(`nudge:${now.toISOString().slice(0, 10)}`, "nudge", await nudgeContent(db, waiting, days));
      }
    }
  });

  // Monthly summary: last month, on the 1st (or the next few days if the server was off)
  if (prefs.monthlySummary && now.getDate() <= 5 && morning) await section(async () => {
    const last = previousMonth(cur.year, cur.month);
    const key = `summary:${ymKey(last)}`;
    if (!(await findMonth(db, last)) || (await logged(key))) return;
    const content = await summaryContent(db, last, ai, prefs.monthlySummaryAi);
    if (content) await send(key, "summary", content);
  });

  // Monthly insights: last month, on the 2nd (the day after the summary)
  if (prefs.monthlyInsights && now.getDate() >= 2 && now.getDate() <= 6 && morning) await section(async () => {
    const last = previousMonth(cur.year, cur.month);
    const key = `insights:${ymKey(last)}`;
    if (!(await findMonth(db, last)) || (await logged(key))) return;
    const content = await insightsContent(db, last, ai);
    if (content) await send(key, "insights", content);
  });

  // Bank needs attention: once per problem; when a bank is fixed, the next problem is new again
  if (prefs.bankAttention && (await isOn(db, "plaid"))) await section(async () => {
    for (const item of await db.select().from(plaidItems)) {
      if (item.status === "ok") {
        await db.delete(notificationLog).where(sql`${notificationLog.key} like ${`${p}bank:${item.id}:%`}`);
        continue;
      }
      await send(`bank:${item.id}:${item.status}`, "bank", bankAttention({ bank: item.institutionName, status: item.status, message: item.errorMessage, lastSynced: item.lastSyncedAt ? item.lastSyncedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : null }));
    }
  });

  // Over budget: items that went over this month, once each (one email for all the new ones)
  if (prefs.overBudget) await section(async () => {
    const m = await findMonth(db, cur);
    if (!m || m.closedAt) return;
    const fresh = [];
    for (const o of await overItems(db, m.id)) if (!(await logged(`over:${ymKey(cur)}:${o.id}`))) fresh.push(o);
    if (!fresh.length) return;
    await sendMany(fresh.map((o) => `over:${ymKey(cur)}:${o.id}`), "over-budget", overBudget({ monthName: monthName(cur), items: fresh }));
  });

  // Weekly check-in, on the chosen day
  if (prefs.weekly && now.getDay() === prefs.weeklyDay && morning) await section(async () => {
    const key = `weekly:${isoDay(now)}`;
    if (!(await findMonth(db, cur))) return; // nothing to check in on without a budget
    if (!(await logged(key))) await send(key, "weekly", await weeklyContent(db, now));
  });

  // Goal milestones (and goals falling behind, at most once a month)
  if (prefs.goalMilestones) await section(async () => {
    for (const f of await targetFunds(db, now)) {
      const steps = f.kind === "goal" ? [25, 50, 75, 100] : [100];
      const crossed = steps.filter((p) => f.pct >= p);
      const fresh = [];
      for (const p of crossed) if (!(await logged(`goal:${f.id}:${p}`))) fresh.push(p);
      if (fresh.length) {
        const top = fresh[fresh.length - 1];
        await sendMany(fresh.map((p) => `goal:${f.id}:${p}`), "goal", goalMilestone({ name: f.name, pct: top, balanceCents: f.balanceCents, targetCents: f.targetCents!, targetDate: f.targetDate ? longDate(f.targetDate) : null, kind: f.kind }));
        continue;
      }
      const late = morning ? behind(f, now) : null;
      if (late) await send(`goal-behind:${f.id}:${ymKey(cur)}`, "goal", goalBehind({ name: f.name, balanceCents: f.balanceCents, expectedCents: late.expected, targetCents: f.targetCents!, targetDate: longDate(f.targetDate!), monthlyCents: late.monthly }));
    }
  });

  // Large purchases that just came in
  if (prefs.largePurchase) await section(async () => {
    const fresh = [];
    for (const r of await largeRecent(db, now, prefs.largePurchaseCents)) if (!(await logged(`large:${r.id}`))) fresh.push(r);
    if (fresh.length) await sendMany(fresh.map((r) => `large:${r.id}`), "large-purchase", largePurchase({ thresholdCents: prefs.largePurchaseCents, items: fresh.map(largeRow) }));
  });

  // Next month isn't set up, a few days before it starts (only while this month has a budget)
  if (prefs.nextMonth && morning) await section(async () => {
    const daysIn = new Date(cur.year, cur.month, 0).getDate();
    const startsIn = daysIn - now.getDate() + 1;
    const next = nextMonth(cur.year, cur.month);
    if (startsIn > prefs.nextMonthDays || !(await findMonth(db, cur)) || (await findMonth(db, next))) return;
    await send(`next-month:${ymKey(next)}`, "next-month", nextMonthSetup({ monthName: monthName(next), startsIn }));
  });

  if (errors.length) throw errors[0];
  return sent;
}

/** New sign-in alert, sent right away (not on the hourly check). Never throws. */
export async function notifyNewSignIn(db: Db, mail: MailService, s: { userId?: number; sessionId: number; userAgent: string | null; ip: string; how: string; at: Date }) {
  try {
    // To the person who signed in, if their alert is on
    const prefs = await getNotificationPrefs(db, s.userId);
    if (!prefs.enabled || !prefs.newSignIn) return false;
    const active = await mail.active();
    const user = await recipient(db, s.userId);
    if (!active || !user?.email) return false;
    const key = `signin:${s.sessionId}:${s.at.getTime()}`;
    const claimed = await db.insert(notificationLog).values({ key, kind: "sign-in", sentTo: user.email, sentAt: s.at }).onConflictDoNothing().returning();
    if (!claimed.length) return false;
    const content = newSignIn({ device: describeDevice(s.userAgent).label, ip: s.ip, how: s.how, when: s.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) });
    await mail.sendRendered(user.email, renderEmail(content, { theme: user.theme, appUrl: active.config.appUrl }), "sign-in");
    return true;
  } catch {
    return false; // logged by the mail service; signing in carries on
  }
}

// Remember when each person last used the app (at most every few minutes)
const lastMark = new Map<number, number>();
export async function markActive(db: Db, userId: number, now = Date.now()) {
  if (Math.abs(now - (lastMark.get(userId) ?? 0)) < 5 * 60 * 1000) return;
  lastMark.set(userId, now);
  await db.update(users).set({ lastActiveAt: new Date(now) }).where(eq(users.id, userId));
}
export const resetActiveMark = () => {
  lastMark.clear();
};
