import "dotenv/config";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { backfillMerchantKeys } from "./lib/merchant.js";
import { buildApp, defaultBackupDir } from "./app.js";
import { startBackupSchedule } from "./lib/backup.js";
import { emailConfigFromEnv } from "./lib/mail.js";

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
const port = Number(process.env.PORT ?? 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
