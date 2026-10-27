import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sinkingFunds } from "../db/schema.js";
import { loadFunds } from "../lib/budget.js";
import { notFound } from "../lib/errors.js";
import { cents, idParam, name } from "../lib/validation.js";

const today = () => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
};

export default async function fundRoutes(app: FastifyInstance) {
  const { db } = app;

  // Balances as of the current month (or ?year=&month=)
  app.get("/api/funds", async (req) => {
    const q = z
      .object({
        year: z.coerce.number().int().optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
        includeArchived: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const asOf = q.year && q.month ? { year: q.year, month: q.month } : today();
    return loadFunds(db, asOf, { includeArchived: q.includeArchived === "true" });
  });

  app.post("/api/funds", async (req, reply) => {
    const body = z
      .object({ name, targetCents: cents.nullable().optional(), startingBalanceCents: z.number().int().default(0) })
      .parse(req.body);
    const [row] = await db.insert(sinkingFunds).values(body).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/funds/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: name.optional(),
        targetCents: cents.nullable().optional(),
        startingBalanceCents: z.number().int().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    const [row] = await db.update(sinkingFunds).set(body).where(eq(sinkingFunds.id, id)).returning();
    if (!row) throw notFound("Sinking fund");
    return row;
  });

  // Deleting a fund unlinks its line items (they stay in the budget)
  app.delete("/api/funds/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await db.delete(sinkingFunds).where(eq(sinkingFunds.id, id)).returning({ id: sinkingFunds.id });
    if (!deleted.length) throw notFound("Sinking fund");
    return reply.status(204).send();
  });
}
