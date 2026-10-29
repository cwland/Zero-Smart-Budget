import "dotenv/config";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { backfillMerchantKeys } from "./lib/merchant.js";
import { buildApp, defaultBackupDir } from "./app.js";
import { startBackupSchedule } from "./lib/backup.js";
import { emailConfigFromEnv } from "./lib/mail.js";
import { syncAll } from "./lib/plaidSync.js";
import { autoSuggest } from "./lib/aiSuggest.js";
import { autoCloseOldMonths } from "./lib/monthClose.js";
import { runNotifications } from "./lib/notifications.js";
import { logEvent } from "./lib/appLog.js";

const { db } = createDb(process.env.DATABASE_URL!);
await runMigrations(db);
await backfillMerchantKeys(db); // transactions saved before merchant matching existed

const backupDir = process.env.BACKUP_DIR || defaultBackupDir;
const backupKeep = Number(process.env.BACKUP_KEEP ?? 30);

const app = buildApp({
  db,
  jwtSecret: process.env.JWT_SECRET ?? "",
  logger: true,
  backupDir,
  backupKeep,
  emailEnv: emailConfigFromEnv(process.env),
});

// Daily automatic backup (set BACKUP_ENABLED=false to turn off)
if (process.env.BACKUP_ENABLED !== "false") {
  startBackupSchedule(db, backupDir, backupKeep, {
    info: (msg) => app.log.info(msg),
    error: (err) => app.log.error(err),
  }, app.backupSecrets());
}
// Remind on every start: the backup key can't be recovered
if (app.backupKey.key) app.log.info("BACKUP_KEY is set: saved keys and passwords go into backups, encrypted. Save a copy of BACKUP_KEY somewhere safe, away from this server; restoring them needs it.");
else if (app.backupKey.problem) app.log.warn(app.backupKey.problem);

// Import bank transactions through Plaid every few hours (PLAID_SYNC_HOURS=0 turns it off)
const syncHours = Number(process.env.PLAID_SYNC_HOURS ?? 6);
if (syncHours > 0) {
  const run = () =>
    syncAll(db, app.plaid)
      .then(async (results) => {
        if (results.some((r) => r.added)) autoSuggest(db, app.ai, app.log);
        if (results.length) {
          const failed = results.filter((r) => r.error).length;
          const sum = (k: "added" | "updated" | "removed") => results.reduce((n, r) => n + r[k], 0);
          await logEvent(db, {
            category: "schedule",
            level: failed ? "warning" : "info",
            source: "Bank sync",
            event: failed ? `Bank sync ran; ${failed} of ${results.length} bank${results.length === 1 ? "" : "s"} failed` : `Bank sync ran (${results.length} bank${results.length === 1 ? "" : "s"})`,
            detail: `${sum("added")} new, ${sum("updated")} updated, ${sum("removed")} removed`,
          });
        }
        for (const r of results) {
          if (r.error) app.log.warn(`Plaid sync ${r.institutionName}: ${r.error}`);
          else if (r.added || r.updated || r.removed) app.log.info(`Plaid sync ${r.institutionName}: ${r.added} new, ${r.updated} updated, ${r.removed} removed`);
        }
      })
      .catch(async (err) => {
        app.log.error(err);
        await logEvent(db, { category: "schedule", level: "error", source: "Bank sync", event: "Bank sync failed", detail: (err as Error).message });
      });
  setTimeout(run, 60 * 1000); // a minute after starting
  setInterval(run, syncHours * 60 * 60 * 1000);
}

// Month Close: months two or more months old close themselves (checked at start and every 6 hours)
const autoClose = () =>
  autoCloseOldMonths(db)
    .then(async (n) => {
      if (!n) return;
      app.log.info(`Closed ${n} old month(s) automatically`);
      await logEvent(db, { category: "schedule", level: "info", source: "Month Wrap-Up", event: `Wrapped up ${n} old month${n === 1 ? "" : "s"} automatically` });
    })
    .catch(async (err) => {
      app.log.error(err);
      await logEvent(db, { category: "schedule", level: "error", source: "Month Wrap-Up", event: "Automatic Wrap-Up failed", detail: (err as Error).message });
    });
autoClose();
setInterval(autoClose, 6 * 60 * 60 * 1000);

// Email notifications (Month Close reminder, "come back" nudge): checked every hour
const notify = () =>
  runNotifications(db, app.mail)
    .then(async (r) => {
      if (!r.sent.length) return; // runs hourly: only runs that sent something are logged
      app.log.info(`Sent ${r.sent.map((x) => x.kind).join(", ")} email`);
      await logEvent(db, { category: "schedule", level: "info", source: "Notifications", event: `Notifications sent: ${r.sent.length}`, detail: r.sent.map((x) => x.subject).join("; ") });
    })
    .catch(async (err) => {
      app.log.error(err);
      await logEvent(db, { category: "schedule", level: "error", source: "Notifications", event: "Notification check failed", detail: (err as Error).message });
    });
setTimeout(notify, 2 * 60 * 1000);
setInterval(notify, 60 * 60 * 1000);

const port = Number(process.env.PORT ?? 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
