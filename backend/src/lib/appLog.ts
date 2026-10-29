import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appLog } from "../db/schema.js";

// Settings > Logs. One line per event, kept 30 days:
//  - email:    every email sent or failed (type and subject, never the message)
//  - ai:       an AI service that didn't answer, timed out, or answered with something unusable
//  - bank:     bank (Plaid) sync results and connection problems
//  - api:      requests from API keys that were refused, and server errors
//  - schedule: scheduled task runs (backups, bank sync, notifications, Wrap-Up, AI suggestions)
export const LOG_CATEGORIES = ["email", "ai", "bank", "api", "schedule"] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type LogLevel = "info" | "warning" | "error";
export const LOG_DAYS = 30;

export interface LogEntry {
  category: LogCategory;
  level: LogLevel;
  event: string;
  source?: string | null;
  detail?: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);
const cutoff = () => new Date(Date.now() - LOG_DAYS * 24 * 60 * 60 * 1000);
let writes = 0;

// Best effort: a log problem never breaks what's being logged
export async function logEvent(db: Db, e: LogEntry) {
  try {
    await db.insert(appLog).values({ category: e.category, level: e.level, event: clip(e.event, 300)!, source: clip(e.source, 120), detail: clip(e.detail, 1000) });
    if (++writes % 50 === 0) await db.delete(appLog).where(lt(appLog.at, cutoff()));
  } catch {
    // ignore
  }
}

// Newest first; optionally one category and/or problems only
export async function recentLogs(db: Db, opts: { category?: LogCategory; problemsOnly?: boolean; limit?: number } = {}) {
  await db.delete(appLog).where(lt(appLog.at, cutoff()));
  const where: SQL[] = [];
  if (opts.category) where.push(eq(appLog.category, opts.category));
  if (opts.problemsOnly) where.push(inArray(appLog.level, ["warning", "error"]));
  return db
    .select()
    .from(appLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(appLog.at), desc(appLog.id))
    .limit(opts.limit ?? 1000);
}
