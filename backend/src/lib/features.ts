import { count, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiKeys, appSettings } from "../db/schema.js";

// Master on/off switches (Settings > Plaid, AI and API keys). Off hides that section's settings
// and stops the feature, but keeps everything saved (keys, banks, services) for when it's back on.
//  - plaid:   no bank syncing or linking (connected banks and imported transactions stay)
//  - ai:      no AI suggestions (Settings > Budget's AI categorization is greyed out)
//  - apiKeys: every request with an API key is refused
export const FEATURES = ["plaid", "ai", "apiKeys"] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

// Never switched yet: on if that feature has been set up already, so nothing stops by surprise
async function defaults(db: Db): Promise<Features> {
  const rows = await db.select({ key: appSettings.key }).from(appSettings);
  const has = new Set(rows.map((r) => r.key));
  const [{ n }] = await db.select({ n: count() }).from(apiKeys);
  return { plaid: has.has("plaid"), ai: has.has("ai"), apiKeys: n > 0 };
}

async function saved(db: Db): Promise<Partial<Features>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "features"));
  return (row?.value ?? {}) as Partial<Features>;
}

export async function getFeatures(db: Db): Promise<Features> {
  const s = await saved(db);
  if (FEATURES.every((f) => typeof s[f] === "boolean")) return s as Features;
  return { ...(await defaults(db)), ...s };
}

// Only switches the user has flipped are stored; the others keep following their defaults
export async function setFeatures(db: Db, changes: Partial<Features>) {
  const value = { ...(await saved(db)), ...changes };
  await db
    .insert(appSettings)
    .values({ key: "features", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return getFeatures(db);
}

export const isOn = async (db: Db, f: Feature) => (await getFeatures(db))[f];
