import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { fundEntries, lineItems, sinkingFunds } from "../db/schema.js";
import { loadFunds } from "../lib/budget.js";
import { HttpError, notFound } from "../lib/errors.js";
import { cents, idParam, isoDate, name } from "../lib/validation.js";

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

  // ---------- history ----------

  // Newest first. "live" entries follow a linked budget item and change with it;
  // the rest (adjustments, and history from unlinked/deleted items) can be deleted here.
  app.get("/api/funds/:id/entries", async (req) => {
    const { id } = idParam.parse(req.params);
    const [fund] = await db.select({ id: sinkingFunds.id }).from(sinkingFunds).where(eq(sinkingFunds.id, id));
    if (!fund) throw notFound("Sinking fund");
    const rows = await db
      .select({
        id: fundEntries.id,
        kind: fundEntries.kind,
        date: fundEntries.date,
        amountCents: fundEntries.amountCents,
        description: fundEntries.description,
        lineItemId: fundEntries.lineItemId,
        transactionId: fundEntries.transactionId,
        itemFundId: lineItems.sinkingFundId,
      })
      .from(fundEntries)
      .leftJoin(lineItems, eq(fundEntries.lineItemId, lineItems.id))
      .where(eq(fundEntries.fundId, id))
      .orderBy(desc(fundEntries.date), desc(fundEntries.id));
    return rows.map(({ itemFundId, ...e }) => ({ ...e, live: e.kind !== "adjustment" && itemFundId === id }));
  });

  // Add money to a fund by hand (positive) or take it out (negative)
  app.post("/api/funds/:id/entries", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        date: isoDate,
        amountCents: z.number().int().refine((n) => n !== 0, "Amount can't be zero").refine((n) => Math.abs(n) <= 2_000_000_000, "Too large"),
        description: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    const [fund] = await db.select({ id: sinkingFunds.id }).from(sinkingFunds).where(eq(sinkingFunds.id, id));
    if (!fund) throw notFound("Sinking fund");
    const [row] = await db
      .insert(fundEntries)
      .values({ fundId: id, kind: "adjustment", date: body.date, amountCents: body.amountCents, description: body.description || null })
      .returning();
    return reply.status(201).send({ ...row, live: false });
  });

  app.delete("/api/funds/:id/entries/:entryId", async (req, reply) => {
    const { id, entryId } = z
      .object({ id: z.coerce.number().int().positive(), entryId: z.coerce.number().int().positive() })
      .parse(req.params);
    const [entry] = await db
      .select({ id: fundEntries.id, kind: fundEntries.kind, itemFundId: lineItems.sinkingFundId })
      .from(fundEntries)
      .leftJoin(lineItems, eq(fundEntries.lineItemId, lineItems.id))
      .where(and(eq(fundEntries.id, entryId), eq(fundEntries.fundId, id)));
    if (!entry) throw notFound("Entry");
    if (entry.kind !== "adjustment" && entry.itemFundId === id) {
      throw new HttpError(400, "This entry follows a linked budget item. Change the item or its transaction instead.");
    }
    await db.delete(fundEntries).where(eq(fundEntries.id, entryId));
    return reply.status(204).send();
  });
}
