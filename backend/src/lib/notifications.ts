import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings, budgetMonths, notificationLog, transactions, transactionSplits, users } from "../db/schema.js";
import type { EmailKind, MailService } from "./mail.js";
import { closeAvailable, monthName } from "./monthClose.js";
import { getBudgetPrefs } from "./prefs.js";
import { monthIndex, previousMonth } from "./calc.js";

// Email notifications (Settings > Budget > Notifications). Checked every hour; each one is logged
// so it's sent once:
//  - Month Close reminder: when a month's Month Close button appears (once per month)
//  - Nudge: you haven't used the app for X days and there are uncategorized transactions
//    (at most once every X days)
//  - Monthly summary: comes with Reports

export interface NotificationPrefs {
  enabled: boolean;
  monthCloseReminder: boolean;
  nudge: boolean;
  nudgeDays: number;
  monthlySummary: boolean; // not sent yet (Reports)
}
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { enabled: false, monthCloseReminder: true, nudge: true, nudgeDays: 7, monthlySummary: false };

export async function getNotificationPrefs(db: Db): Promise<NotificationPrefs> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "notifications"));
  return { ...DEFAULT_NOTIFICATION_PREFS, ...((row?.value as Partial<NotificationPrefs>) ?? {}) };
}

export async function saveNotificationPrefs(db: Db, changes: Partial<NotificationPrefs>) {
  const value = { ...(await getNotificationPrefs(db)), ...changes };
  await db
    .insert(appSettings)
    .values({ key: "notifications", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return value;
}

// The one user's email (notifications go there)
export async function recipient(db: Db) {
  const [u] = await db.select({ email: users.email, lastActiveAt: users.lastActiveAt, createdAt: users.createdAt, name: users.displayName }).from(users).orderBy(asc(users.id)).limit(1);
  return u ?? null;
}

const DAY = 24 * 60 * 60 * 1000;

async function uncategorizedCount(db: Db) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.pending, false),
        sql`not exists (select 1 from ${transactionSplits} s where s.transaction_id = ${transactions.id} and (s.line_item_id is not null or s.income_item_id is not null))`
      )
    );
  return n;
}

const footer = (appUrl: string | null) => (appUrl ? `\n\nOpen Zero Smart Budget: ${appUrl}` : "") + "\n\nYou can turn these emails off in Settings > Budget > Notifications.";

export interface NotificationResult {
  sent: { key: string; kind: string; to: string; subject: string }[];
  skipped?: string;
}

/** Send whatever is due. Safe to call often: each notification goes out once. */
export async function runNotifications(db: Db, mail: MailService, now = new Date()): Promise<NotificationResult> {
  const prefs = await getNotificationPrefs(db);
  if (!prefs.enabled) return { sent: [], skipped: "notifications are off" };
  const active = await mail.active();
  if (!active) return { sent: [], skipped: "email isn't set up" };
  const user = await recipient(db);
  if (!user?.email) return { sent: [], skipped: "no email address on your profile" };
  const appUrl = active.config.appUrl ?? null;
  const sent: NotificationResult["sent"] = [];

  const send = async (key: string, kind: string, subject: string, text: string) => {
    // Claim the key first, so two runs can't both send it
    const claimed = await db.insert(notificationLog).values({ key, kind, sentTo: user.email!, sentAt: now }).onConflictDoNothing().returning();
    if (!claimed.length) return;
    try {
      await mail.send({ to: user.email!, subject, text: text + footer(appUrl) }, undefined, kind as EmailKind);
      sent.push({ key, kind, to: user.email!, subject });
    } catch (e) {
      await db.delete(notificationLog).where(eq(notificationLog.key, key)); // try again next time
      throw e;
    }
  };

  // Month Close reminder: this month (once its button shows) or last month if it's still open
  const budget = await getBudgetPrefs(db);
  if (prefs.monthCloseReminder && budget.monthCloseEnabled) {
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    for (const ym of [previousMonth(cur.year, cur.month), cur]) {
      const [m] = await db.select().from(budgetMonths).where(and(eq(budgetMonths.year, ym.year), eq(budgetMonths.month, ym.month)));
      if (!m || m.closedAt || !closeAvailable(m, now, budget.monthCloseDays)) continue;
      const name = monthName(m);
      const ending = monthIndex(ym.year, ym.month) < monthIndex(cur.year, cur.month) ? `${name} is over` : `${name} is almost over`;
      await send(
        `month-close:${ym.year}-${String(ym.month).padStart(2, "0")}`,
        "month-close",
        `Time to wrap up ${name}`,
        `${ending}. Open your budget and click Wrap Up to see where you came out ahead or went over, and decide where any extra money goes.`
      );
    }
  }

  // Nudge: away for X days with transactions waiting
  if (prefs.nudge) {
    const last = (user.lastActiveAt ?? user.createdAt).getTime();
    const away = now.getTime() - last >= prefs.nudgeDays * DAY;
    if (away) {
      const [lastNudge] = await db.select().from(notificationLog).where(eq(notificationLog.kind, "nudge")).orderBy(desc(notificationLog.sentAt)).limit(1);
      const nudgedRecently = lastNudge && now.getTime() - lastNudge.sentAt.getTime() < prefs.nudgeDays * DAY && lastNudge.sentAt.getTime() > last;
      const waiting = await uncategorizedCount(db);
      if (!nudgedRecently && waiting > 0) {
        const days = Math.floor((now.getTime() - last) / DAY);
        await send(
          `nudge:${now.toISOString().slice(0, 10)}`,
          "nudge",
          `${waiting} transaction${waiting === 1 ? " is" : "s are"} waiting for you`,
          `It's been ${days} days since you last checked your budget, and ${waiting} transaction${waiting === 1 ? " hasn't" : "s haven't"} been given a budget item yet. A few minutes now keeps your budget on track.`
        );
      }
    }
  }
  return { sent };
}

// Remember when the app was last used (at most every few minutes)
let lastMark = 0;
export async function markActive(db: Db, userId: number, now = Date.now()) {
  if (Math.abs(now - lastMark) < 5 * 60 * 1000) return;
  lastMark = now;
  await db.update(users).set({ lastActiveAt: new Date(now) }).where(eq(users.id, userId));
}
export const resetActiveMark = () => {
  lastMark = 0;
};
