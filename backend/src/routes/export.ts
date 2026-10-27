import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BACKUP_NAME, listBackups, pruneBackups, writeBackup } from "../lib/backup.js";
import { budgetCsv, buildExport, importData, importSchema, transactionsCsv } from "../lib/dataExport.js";
import { HttpError, notFound } from "../lib/errors.js";
import { isoDate } from "../lib/validation.js";

const today = () => new Date().toISOString().slice(0, 10);

function requireLogin(req: FastifyRequest) {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
}

export default async function exportRoutes(app: FastifyInstance) {
  const { db } = app;

  // ---------- downloads ----------

  app.get("/api/export", async (_req, reply) => {
    const data = await buildExport(db);
    return reply.header("Content-Disposition", `attachment; filename="corys-dollar-${today()}.json"`).send(data);
  });

  app.get("/api/export/transactions.csv", async (req, reply) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="corys-dollar-transactions-${today()}.csv"`)
      .send(await transactionsCsv(db, q.from, q.to));
  });

  app.get("/api/export/budget.csv", async (req, reply) => {
    const q = z
      .object({ year: z.coerce.number().int().optional(), month: z.coerce.number().int().min(1).max(12).optional() })
      .parse(req.query);
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="corys-dollar-budget-${today()}.csv"`)
      .send(await budgetCsv(db, q.year, q.month));
  });

  // ---------- backups ----------

  app.get("/api/backups", async () => ({
    dir: app.backupDir,
    keep: app.backupKeep,
    backups: await listBackups(app.backupDir),
  }));

  app.post("/api/backups", async (_req, reply) => {
    const created = await writeBackup(db, app.backupDir);
    await pruneBackups(app.backupDir, app.backupKeep);
    return reply.status(201).send(created);
  });

  app.get("/api/backups/:name", async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    if (!BACKUP_NAME.test(name)) throw notFound("Backup"); // also blocks ../ paths
    try {
      const data = await fs.readFile(path.join(app.backupDir, name));
      return reply.type("application/json").header("Content-Disposition", `attachment; filename="${name}"`).send(data);
    } catch {
      throw notFound("Backup");
    }
  });

  // ---------- restore ----------
  // Replaces all budget data with an export/backup file. Must be logged in (not an API key)
  // and pass ?confirm=replace. A safety backup is written first.
  app.post("/api/import", { bodyLimit: 100 * 1024 * 1024 }, async (req) => {
    requireLogin(req);
    const { confirm } = z.object({ confirm: z.string().optional() }).parse(req.query);
    if (confirm !== "replace") throw new HttpError(400, "Add ?confirm=replace to restore (this replaces all budget data)");

    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "That file isn't a Cory's Dollar backup");

    const safety = await writeBackup(db, app.backupDir, "before-restore");
    try {
      const counts = await importData(db, parsed.data);
      return { ok: true, safetyBackup: safety.name, ...counts };
    } catch (err) {
      req.log.error(err);
      throw new HttpError(400, `Couldn't restore that file, nothing was changed (${(err as Error).message.split("\n")[0]})`);
    }
  });
}
