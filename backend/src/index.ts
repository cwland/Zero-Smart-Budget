import "dotenv/config";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { backfillMerchantKeys } from "./lib/merchant.js";
import { buildApp, defaultBackupDir } from "./app.js";
import { startBackupSchedule } from "./lib/backup.js";
import { emailConfigFromEnv } from "./lib/mail.js";
import { syncAll } from "./lib/plaidSync.js";

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
  });
}
// Import bank transactions through Plaid every few hours (PLAID_SYNC_HOURS=0 turns it off)
const syncHours = Number(process.env.PLAID_SYNC_HOURS ?? 6);
if (syncHours > 0) {
  const run = () =>
    syncAll(db, app.plaid)
      .then((results) => {
        for (const r of results) {
          if (r.error) app.log.warn(`Plaid sync ${r.institutionName}: ${r.error}`);
          else if (r.added || r.updated || r.removed) app.log.info(`Plaid sync ${r.institutionName}: ${r.added} new, ${r.updated} updated, ${r.removed} removed`);
        }
      })
      .catch((err) => app.log.error(err));
  setTimeout(run, 60 * 1000); // a minute after starting
  setInterval(run, syncHours * 60 * 60 * 1000);
}

const port = Number(process.env.PORT ?? 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
