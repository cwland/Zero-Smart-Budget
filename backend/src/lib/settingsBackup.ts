import { inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

// Settings go into backups too (budget, notifications, AI services, email server, Plaid keys).
// Saved keys and passwords are only included when BACKUP_KEY is set (in .env or the compose file):
// they're decrypted with the server's own secret and encrypted again with BACKUP_KEY, so the
// backup file can be restored on another server (one with a different JWT_SECRET) that has the
// same BACKUP_KEY. Without BACKUP_KEY the settings are still backed up, minus the secrets.

export const SETTING_KEYS = ["budget", "notifications", "ai", "email", "plaid"] as const;
export const BACKUP_KEY_MIN = 16;

export interface BackupSecrets {
  jwtSecret: string;
  backupKey: string | null; // null: not set (or too short), so secrets are left out
}

// BACKUP_KEY from the environment; too short counts as not set (status says why)
export function backupKeyFromEnv(value: string | undefined): { key: string | null; problem: string | null } {
  const v = value?.trim();
  if (!v) return { key: null, problem: null };
  if (v.length < BACKUP_KEY_MIN) return { key: null, problem: `BACKUP_KEY is too short (use at least ${BACKUP_KEY_MIN} characters)` };
  return { key: v, problem: null };
}

// Stands in for a saved secret in a backup made without BACKUP_KEY
const LEFT_OUT = "left-out:set BACKUP_KEY to include";
const backupSecret = (key: string) => `backup:${key}`;
// Secrets in saved settings are stored in fields ending in "Enc" (passwordEnc, apiKeyEnc, ...)
const isSecretField = (k: string, v: unknown) => k.endsWith("Enc") && (typeof v === "string" || v === null);

type Path = (string | number)[];
// Copy a value, changing every secret field with fn (given where it is)
function mapSecrets(value: unknown, fn: (enc: string, path: Path) => string | null, path: Path = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => mapSecrets(v, fn, [...path, i]));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, isSecretField(k, v) ? (typeof v === "string" ? fn(v, [...path, k]) : null) : mapSecrets(v, fn, [...path, k])])
    );
  }
  return value;
}

const getAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>((v, p) => (v && typeof v === "object" ? (v as Record<string | number, unknown>)[p] : undefined), value);

export interface SettingsSection {
  secrets: "encrypted" | "left out"; // encrypted: with BACKUP_KEY
  values: Record<string, unknown>;
}

export async function exportSettings(db: Db, s: BackupSecrets): Promise<SettingsSection> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, [...SETTING_KEYS]));
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    values[row.key] = mapSecrets(row.value, (enc) => {
      if (!s.backupKey) return LEFT_OUT;
      const plain = decryptSecret(enc, s.jwtSecret);
      return plain === null ? null : encryptSecret(plain, backupSecret(s.backupKey));
    });
  }
  return { secrets: s.backupKey ? "encrypted" : "left out", values };
}

// How many of the file's encrypted keys and passwords this backup key can read
export function checkBackupKey(section: SettingsSection, key: string) {
  let total = 0;
  let readable = 0;
  mapSecrets(section.values, (enc) => {
    if (enc === LEFT_OUT) return enc;
    total++;
    if (decryptSecret(enc, backupSecret(key)) !== null) readable++;
    return enc;
  });
  return { total, readable };
}

// Puts the backup's settings back. Settings not in the file are left as they are.
// Returns how many secrets came back and how many couldn't (no/different BACKUP_KEY, or left out).
export async function importSettings(db: Db, section: SettingsSection, s: BackupSecrets) {
  let restored = 0;
  let missing = 0;
  let kept = 0;
  const current = Object.fromEntries((await db.select().from(appSettings).where(inArray(appSettings.key, [...SETTING_KEYS]))).map((r) => [r.key, r.value]));
  for (const key of SETTING_KEYS) {
    if (!(key in section.values)) continue;
    const value = mapSecrets(section.values[key], (enc, path) => {
      const plain = s.backupKey && enc !== LEFT_OUT ? decryptSecret(enc, backupSecret(s.backupKey)) : null;
      if (plain === null) {
        // Can't read it from the backup: keep what this server already has there, if anything
        const mine = getAt(current[key], path);
        if (typeof mine === "string" && decryptSecret(mine, s.jwtSecret) !== null) {
          kept++;
          return mine;
        }
        missing++;
        return null;
      }
      restored++;
      return encryptSecret(plain, s.jwtSecret);
    });
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }
  return { settingsRestored: SETTING_KEYS.filter((k) => k in section.values).length, secretsRestored: restored, secretsKept: kept, secretsMissing: missing };
}
