import { isNull, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { transactions } from "../db/schema.js";

// Bank descriptions carry noise that changes every time: card/account numbers, reference
// numbers, dates, and words like ACH / POS / DEBIT. Strip it so repeat merchants match.
const NOISE_WORDS = new Set([
  "ach", "pos", "dbt", "debit", "credit", "crd", "card", "checkcard", "purchase", "recurring",
  "visa", "mc", "web", "ppd", "ccd", "id", "ref", "trn", "txn", "online", "pmnt", "xx", "xxxx",
  "the", "inc", "llc", "co",
]);

export function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " "); // dates like 10/13 or 10/13/26
  s = s.replace(/[*#]\s*[a-z0-9]+/g, " "); // *4986, #1234, *ab12cd
  s = s.replace(/\b[a-z]*\d[a-z0-9]*\b/g, " "); // any word containing digits (store numbers, refs)
  s = s.replace(/['’]/g, ""); // trader joe's -> trader joes
  s = s.replace(/[^a-z]+/g, " ");
  const words = s.split(" ").filter((w) => w && !NOISE_WORDS.has(w));
  return words.join(" ").trim();
}

// Fill in merchant_key for transactions saved before it existed (or restored from old backups)
export async function backfillMerchantKeys(db: Db) {
  const rows = await db.select({ id: transactions.id, merchant: transactions.merchant }).from(transactions).where(isNull(transactions.merchantKey));
  for (const r of rows) {
    await db.update(transactions).set({ merchantKey: normalizeMerchant(r.merchant) }).where(eq(transactions.id, r.id));
  }
  return rows.length;
}
