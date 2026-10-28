// TEMPORARY testing tool: the red reset button at the bottom-left of the app.
// To remove: delete this file and frontend/src/components/DevReset.tsx, then remove the
// lines marked "TEMPORARY testing tool" in app.ts, AppShell.tsx and AccountMenu.tsx.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { writeBackup } from "../lib/backup.js";
import { HttpError } from "../lib/errors.js";

const BUDGET_TABLES = "budget_months, sinking_funds, transactions"; // cascades to groups, items, income, splits, fund history
const ACCOUNT_TABLES = "users, api_keys, app_settings"; // cascades to password resets

export default async function devResetRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post("/api/dev/reset", async (req) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
    const body = z
      .object({ scope: z.enum(["transactions", "budget", "everything"]), confirm: z.string() })
      .parse(req.body);
    if (body.confirm !== "RESET") throw new HttpError(400, 'Type RESET to confirm');

    const backup = await writeBackup(db, app.backupDir, "before-reset");
    await db.transaction(async (tx) => {
      if (body.scope === "transactions") {
        await tx.execute(sql`delete from transactions`); // also removes splits and fund spending entries
        await tx.execute(sql`select setval(pg_get_serial_sequence('transactions', 'id'), 1, false)`);
      } else if (body.scope === "budget") {
        await tx.execute(sql.raw(`truncate ${BUDGET_TABLES} restart identity cascade`));
      } else {
        await tx.execute(sql.raw(`truncate ${BUDGET_TABLES}, ${ACCOUNT_TABLES} restart identity cascade`));
      }
    });
    req.log.warn(`Testing reset: ${body.scope} (backup ${backup.name})`);
    return { ok: true, scope: body.scope, backup: backup.name };
  });
}
