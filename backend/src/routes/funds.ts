import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { fundEntries, lineItems, sinkingFunds } from "../db/schema.js";
import { loadFunds } from "../lib/budget.js";
import { previousMonth } from "../lib/calc.js";
import { addGoalToBudget, goalPlan } from "../lib/goals.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { cents, idParam, isoDate, name } from "../lib/validation.js";

const kind = z.enum(["sinking", "goal"]);
// A goal's month: "2027-03" or "2027-03-15" -> "2027-03-01"
const goalMonth = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use YYYY-MM")
  .transform((v) => `${v.slice(0, 7)}-01`)
  .refine((v) => Number(v.slice(5, 7)) >= 1 && Number(v.slice(5, 7)) <= 12, "Not a real month");
const goalNeedsTarget = (k: string | undefined, target: number | null | undefined) => {
  if (k === "goal" && !target) throw badRequest("A goal needs a target amount");
};

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
    const funds = await loadFunds(db, asOf, { includeArchived: q.includeArchived === "true" });
    // A goal's monthly amount is worked out from what was saved before this month's budget line,
    // so the line that saves this month's amount doesn't shrink it
    const now = app.now();
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    const goalIds = funds.filter((f) => f.kind === "goal").map((f) => f.id);
    const [nowFunds, prevFunds] = goalIds.length
      ? await Promise.all([loadFunds(db, cur, { fundIds: goalIds }), loadFunds(db, previousMonth(cur.year, cur.month), { fundIds: goalIds })])
      : [[], []];
    const budgetedThisMonth = new Map(nowFunds.map((f) => [f.id, f.contributedCents - (prevFunds.find((p) => p.id === f.id)?.contributedCents ?? 0)]));
    return funds.map((f) => ({ ...f, plan: goalPlan({ ...f, balanceCents: f.balanceCents - (budgetedThisMonth.get(f.id) ?? 0) }, now) }));
  });

  // Add a goal (EveryDollar style): name, amount, the month to reach it by, what's already saved.
  // It's added to this month's budget as a "Goals" line that saves the monthly amount needed.
  app.post("/api/goals", async (req, reply) => {
    const body = z
      .object({
        name,
        targetCents: cents.refine((n) => n > 0, "Enter the goal amount"),
        targetDate: goalMonth.nullable().optional(),
        startingBalanceCents: z.number().int().min(0).default(0),
        addToBudget: z.boolean().default(true),
      })
      .parse(req.body);
    const [goal] = await db
      .insert(sinkingFunds)
      .values({ name: body.name, kind: "goal", targetCents: body.targetCents, targetDate: body.targetDate ?? null, startingBalanceCents: body.startingBalanceCents })
      .returning();
    const plan = goalPlan({ ...goal, balanceCents: goal.startingBalanceCents }, app.now());
    const addedTo = body.addToBudget && plan?.monthlyCents ? await addGoalToBudget(db, goal, plan.monthlyCents, app.now()) : null;
    return reply.status(201).send({ goal, plan, addedTo });
  });

  app.post("/api/funds", async (req, reply) => {
    const body = z
      .object({ name, kind: kind.default("sinking"), targetCents: cents.nullable().optional(), targetDate: goalMonth.nullable().optional(), startingBalanceCents: z.number().int().default(0) })
      .parse(req.body);
    goalNeedsTarget(body.kind, body.targetCents);
    const [row] = await db.insert(sinkingFunds).values(body).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/funds/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: name.optional(),
        kind: kind.optional(),
        targetCents: cents.nullable().optional(),
        targetDate: goalMonth.nullable().optional(),
        startingBalanceCents: z.number().int().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    const [current] = await db.select().from(sinkingFunds).where(eq(sinkingFunds.id, id));
    if (!current) throw notFound("Sinking fund");
    goalNeedsTarget(body.kind ?? current.kind, body.targetCents === undefined ? current.targetCents : body.targetCents);
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
    // live: follows a linked budget item (or a Month Close), so it's changed there, not here
    return rows.map(({ itemFundId, ...e }) => ({ ...e, live: e.kind === "month_close" || (e.kind !== "adjustment" && itemFundId === id) }));
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
    const [fund] = await db.select({ id: sinkingFunds.id, name: sinkingFunds.name, kind: sinkingFunds.kind, targetCents: sinkingFunds.targetCents }).from(sinkingFunds).where(eq(sinkingFunds.id, id));
    if (!fund) throw notFound("Sinking fund");
    // A goal stops at its target
    if (fund.kind === "goal" && fund.targetCents !== null && body.amountCents > 0) {
      const [now] = await loadFunds(db, { year: 9999, month: 12 }, { fundIds: [id] });
      const room = Math.max(0, fund.targetCents - now.balanceCents);
      if (body.amountCents > room) {
        throw badRequest(room === 0 ? `${fund.name} has already reached its goal.` : `${fund.name} only needs $${(room / 100).toFixed(2)} more to reach its goal.`);
      }
    }
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
    if (entry.kind === "month_close") throw new HttpError(400, "This came from a Month Close. Reopen that month and close it again to change it.");
    if (entry.kind !== "adjustment" && entry.itemFundId === id) {
      throw new HttpError(400, "This entry follows a linked budget item. Change the item or its transaction instead.");
    }
    await db.delete(fundEntries).where(eq(fundEntries.id, entryId));
    return reply.status(204).send();
  });
}
