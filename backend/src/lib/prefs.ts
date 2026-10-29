import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";

// Budget preferences from Settings > Budget, saved in app_settings under "budget"
export interface BudgetPrefs {
  fastTrack: boolean; // suggest budget items for new transactions based on past spending
  tossAnimation: boolean; // accepting a suggestion tosses the transaction into its budget item
  monthCloseDays: number; // the Month Close button shows this many days before the month's last day
  monthCloseEnabled: boolean; // off: no Month Close button, and months never close on their own
  monthCloseAuto: boolean; // months you don't close yourself close on their own two months later
}

export const DEFAULT_BUDGET_PREFS: BudgetPrefs = { fastTrack: true, tossAnimation: true, monthCloseDays: 4, monthCloseEnabled: true, monthCloseAuto: true };

export async function getBudgetPrefs(db: Db): Promise<BudgetPrefs> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "budget"));
  return { ...DEFAULT_BUDGET_PREFS, ...((row?.value as Partial<BudgetPrefs>) ?? {}) };
}

export async function saveBudgetPrefs(db: Db, changes: Partial<BudgetPrefs>): Promise<BudgetPrefs> {
  const value = { ...(await getBudgetPrefs(db)), ...changes };
  await db
    .insert(appSettings)
    .values({ key: "budget", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return value;
}
