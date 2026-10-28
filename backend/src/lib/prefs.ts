import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";

// Budget preferences from Settings > Budget, saved in app_settings under "budget"
export interface BudgetPrefs {
  fastTrack: boolean; // suggest budget items for new transactions based on past spending
  tossAnimation: boolean; // accepting a suggestion tosses the transaction into its budget item
}

export const DEFAULT_BUDGET_PREFS: BudgetPrefs = { fastTrack: true, tossAnimation: true };

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
