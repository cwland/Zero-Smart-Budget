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
      .then((results) => {
        if (results.some((r) => r.added)) autoSuggest(db, app.ai, app.log);
        for (const r of results) {
          if (r.error) app.log.warn(`Plaid sync ${r.institutionName}: ${r.error}`);
          else if (r.added || r.updated || r.removed) app.log.info(`Plaid sync ${r.institutionName}: ${r.added} new, ${r.updated} updated, ${r.removed} removed`);
        }
      })
      .catch((err) => app.log.error(err));
  setTimeout(run, 60 * 1000); // a minute after starting
  setInterval(run, syncHours * 60 * 60 * 1000);
}

// Month Close: months two or more months old close themselves (checked at start and every 6 hours)
const autoClose = () =>
  autoCloseOldMonths(db)
    .then((n) => n && app.log.info(`Closed ${n} old month(s) automatically`))
    .catch((err) => app.log.error(err));
autoClose();
setInterval(autoClose, 6 * 60 * 60 * 1000);

// Email notifications (Month Close reminder, "come back" nudge): checked every hour
const notify = () =>
  runNotifications(db, app.mail)
    .then((r) => r.sent.length && app.log.info(`Sent ${r.sent.map((x) => x.kind).join(", ")} email`))
    .catch((err) => app.log.error(err));
setTimeout(notify, 2 * 60 * 1000);
setInterval(notify, 60 * 60 * 1000);

const port = Number(process.env.PORT ?? 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
