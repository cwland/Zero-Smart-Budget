// Locked out by OAuth? Turns password sign-in back on (and OAuth off), straight in the database.
//   npm run auth:reset                (add -- --keep-oauth to leave OAuth on, password form back)
//   docker compose exec api npm run auth:reset
// Or set EMERGENCY_DISABLE_OAUTH=true in .env and restart: the server does the same on start.
import "dotenv/config";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { emergencyResetAuth } from "../lib/oauth.js";

const keepOAuth = process.argv.includes("--keep-oauth");
const { db, pool } = createDb(process.env.DATABASE_URL!);
try {
  await runMigrations(db);
  const r = await emergencyResetAuth(db, keepOAuth);
  console.log(`Sign-in mode was ${r.was.authMode} (OAuth ${r.was.enabled ? "on" : "off"}).`);
  console.log(`Password sign-in is ON again: mode is now ${r.now.authMode}, OAuth is ${r.now.enabled ? "on" : "off"}.`);
  console.log("Sign in with your username and password. (Forgot it? npm run reset-password)");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
