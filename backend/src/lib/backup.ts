import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/index.js";
import { buildExport } from "./dataExport.js";
import type { BackupSecrets } from "./settingsBackup.js";

// zeropoint-budget-2026-10-27-143005.json, or with a label: zeropoint-budget-2026-10-27-143005-before-restore.json
// (backups from before the rename are named corys-dollar-...)
export const BACKUP_NAME = /^(zeropoint-budget|corys-dollar)-\d{4}-\d{2}-\d{2}-\d{6}(-[a-z-]+)?\.json$/;

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function writeBackup(db: Db, dir: string, secrets: BackupSecrets, label?: string) {
  await fs.mkdir(dir, { recursive: true });
  const name = `zeropoint-budget-${stamp(new Date())}${label ? `-${label}` : ""}.json`;
  const data = JSON.stringify(await buildExport(db, secrets), null, 2);
  const tmp = path.join(dir, `.${name}.tmp`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path.join(dir, name)); // never leave a half-written backup
  return { name, size: Buffer.byteLength(data) };
}

export async function listBackups(dir: string) {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((n) => BACKUP_NAME.test(n))
      .map(async (name) => {
        const st = await fs.stat(path.join(dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString() };
      })
  );
  return files.sort((a, b) => b.name.localeCompare(a.name)); // newest first
}

// Keep the newest `keep` backups, delete older ones
export async function pruneBackups(dir: string, keep: number) {
  const files = await listBackups(dir);
  const old = files.slice(keep);
  await Promise.all(old.map((f) => fs.unlink(path.join(dir, f.name))));
  return old.map((f) => f.name);
}

// Daily automatic backup: checks every hour, backs up if the newest backup is a day old
export function startBackupSchedule(
  db: Db,
  dir: string,
  keep: number,
  log: { info: (msg: string) => void; error: (err: unknown) => void },
  secrets: BackupSecrets
) {
  const DAY = 24 * 60 * 60 * 1000;
  const check = async () => {
    try {
      const [newest] = await listBackups(dir);
      if (newest && Date.now() - new Date(newest.createdAt).getTime() < DAY) return;
      const { name } = await writeBackup(db, dir, secrets);
      const removed = await pruneBackups(dir, keep);
      log.info(`Backup written: ${name}${removed.length ? ` (removed ${removed.length} old)` : ""}`);
    } catch (err) {
      log.error(err);
    }
  };
  void check();
  const timer = setInterval(check, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
