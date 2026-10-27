import "dotenv/config";
import { createDb } from "./index.js";
import { runMigrations } from "./migrate.js";

const { db, pool } = createDb(process.env.DATABASE_URL!);
await runMigrations(db);
console.log("Migrations applied");
await pool.end();
