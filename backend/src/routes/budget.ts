import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, incomeItems, lineItems, sinkingFunds } from "../db/schema.js";
import { loadBudget, loadFunds, nextSortOrder } from "../lib/budget.js";
import { STARTER_GROUPS, STARTER_INCOME } from "../lib/template.js";
import { syncLineItem } from "../lib/fundLedger.js";
import { monthsWaiting } from "../lib/plaidSync.js";
import { monthIndex, previousMonth } from "../lib/calc.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { getBudgetPrefs } from "../lib/prefs.js";
import { applyRollover, assertOpen, closeMonth, closePreview, closeState, reopenMonth } from "../lib/monthClose.js";
import { cents, idList, idParam, name, yearMonthParams } from "../lib/validation.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function findMonth(db: Db, year: number, month: number) {
  const [row] = await db
    .select()
    .from(budgetMonths)
    .where(and(eq(budgetMonths.year, year), eq(budgetMonths.month, month)));
  return row;
}

async function requireMonth(db: Db, id: number) {
  const [row] = await db.select().from(budgetMonths).where(eq(budgetMonths.id, id));
  if (!row) throw notFound("Month");
  return row;
}

async function requireGroup(db: Db, id: number) {
  const [row] = await db.select().from(categoryGroups).where(eq(categoryGroups.id, id));
  if (!row) throw notFound("Group");
  return row;
}

async function requireFund(db: Db, id: number | null | undefined) {
  if (id === null || id === undefined) return;
  const [row] = await db.select({ id: sinkingFunds.id }).from(sinkingFunds).where(eq(sinkingFunds.id, id));
  if (!row) throw badRequest("Sinking fund not found");
}

// Which month a group / line item / income item belongs to (for the closed-month check)
async function monthOfGroup(db: Db, groupId: number) {
  const [g] = await db.select({ monthId: categoryGroups.monthId }).from(categoryGroups).where(eq(categoryGroups.id, groupId));
  return g?.monthId;
}
async function monthOfItem(db: Db, itemId: number) {
  const [i] = await db.select({ groupId: lineItems.groupId }).from(lineItems).where(eq(lineItems.id, itemId));
  return i ? monthOfGroup(db, i.groupId) : undefined;
}
async function openCheck(db: Db, monthId: number | undefined) {
  if (monthId !== undefined) await assertOpen(db, monthId);
}

// Most recent month that exists before the given one
async function findPreviousMonth(db: Db, year: number, month: number) {
  const [row] = await db
    .select()
    .from(budgetMonths)
    .where(lt(sql`${budgetMonths.year} * 12 + (${budgetMonths.month} - 1)`, monthIndex(year, month)))
    .orderBy(desc(budgetMonths.year), desc(budgetMonths.month))
    .limit(1);
  return row;
}

// Set sortOrder to match the given id order. The ids must be exactly the current children.
async function applyOrder(
  tx: Tx,
  table: typeof incomeItems | typeof categoryGroups | typeof lineItems,
  currentIds: number[],
  ids: number[]
) {
  const same = ids.length === currentIds.length && new Set(ids).size === ids.length && ids.every((id) => currentIds.includes(id));
  if (!same) throw badRequest("ids must list every item exactly once");
  for (const [index, id] of ids.entries()) {
    await tx.update(table).set({ sortOrder: index }).where(eq(table.id, id));
  }
}

export default async function budgetRoutes(app: FastifyInstance) {
  const { db } = app;
  // The Month Close state shown with a budget (Settings > Budget decides when the button shows)
  const closeFor = async (row: typeof budgetMonths.$inferSelect, budget: NonNullable<Awaited<ReturnType<typeof loadBudget>>>) => {
    const prefs = await getBudgetPrefs(db);
    return closeState(row, budget, app.now(), prefs.monthCloseDays, prefs.monthCloseEnabled);
  };

  // ---------- months ----------

  app.get("/api/months", async () =>
    db
      .select({ id: budgetMonths.id, year: budgetMonths.year, month: budgetMonths.month })
      .from(budgetMonths)
      .orderBy(asc(budgetMonths.year), asc(budgetMonths.month))
  );

  // Returns the budget, or { exists: false } so the UI can offer to create it
  app.get("/api/months/:year/:month", async (req) => {
    const { year, month } = yearMonthParams.parse(req.params);
    const row = await findMonth(db, year, month);
    if (!row) {
      const previous = await findPreviousMonth(db, year, month);
      return {
        exists: false,
        year,
        month,
        canCopyFrom: previous ? { year: previous.year, month: previous.month } : null,
        // Transactions already in this month (e.g. imported from a bank), shown once it's created
        waitingTransactions: (await monthsWaiting(db)).find((w) => w.year === year && w.month === month)?.count ?? 0,
      };
    }
    const budget = (await loadBudget(db, row.id))!;
    return { exists: true, ...budget, close: await closeFor(row, budget) };
  });

  // ---------- Month Close ----------

  app.get("/api/months/:id/close", async (req) => {
    const { id } = idParam.parse(req.params);
    return closePreview(db, id);
  });

  // Close a month: leftover to ONE fund or goal, rolled over, or kept; overspend covered from ONE fund or goal
  app.post("/api/months/:id/close", async (req) => {
    const { id } = idParam.parse(req.params);
    const fundId = z.number().int().positive();
    const body = z
      .object({
        leftover: z
          .discriminatedUnion("to", [z.object({ to: z.literal("fund"), fundId }), z.object({ to: z.literal("rollover") }), z.object({ to: z.literal("keep") })])
          .optional(),
        overspent: z.discriminatedUnion("to", [z.object({ to: z.literal("fund"), fundId }), z.object({ to: z.literal("keep") })]).optional(),
      })
      .parse(req.body ?? {});
    await requireMonth(db, id);
    const result = await closeMonth(db, id, body);
    return { result, preview: await closePreview(db, id) };
  });

  app.post("/api/months/:id/reopen", async (req) => {
    const { id } = idParam.parse(req.params);
    await requireMonth(db, id);
    await reopenMonth(db, id);
    return { ok: true };
  });

  // Create a month: blank, suggested starter categories ("template"), or a copy of the most recent earlier month
  app.post("/api/months/:year/:month", async (req, reply) => {
    const { year, month } = yearMonthParams.parse(req.params);
    const { mode } = z.object({ mode: z.enum(["blank", "template", "copy"]).default("blank") }).parse(req.body ?? {});
    if (await findMonth(db, year, month)) throw new HttpError(409, "That month already exists");

    const source = mode === "copy" ? await findPreviousMonth(db, year, month) : undefined;
    if (mode === "copy" && !source) throw badRequest("No earlier month to copy from");

    const newId = await db.transaction(async (tx) => {
      const [created] = await tx.insert(budgetMonths).values({ year, month }).returning();
      if (mode === "template") {
        await tx.insert(incomeItems).values(STARTER_INCOME.map((name, sortOrder) => ({ monthId: created.id, name, sortOrder })));
        for (const [sortOrder, g] of STARTER_GROUPS.entries()) {
          const [group] = await tx.insert(categoryGroups).values({ monthId: created.id, name: g.name, sortOrder }).returning();
          await tx.insert(lineItems).values(g.items.map((name, i) => ({ groupId: group.id, name, sortOrder: i })));
        }
        return created.id;
      }
      if (!source) return created.id;

      // (a "Rollover from ..." item belongs to its month only)
      const income = (await tx.select().from(incomeItems).where(eq(incomeItems.monthId, source.id))).filter((i) => !i.rolloverFromMonthId);
      if (income.length) {
        await tx.insert(incomeItems).values(
          income.map((i) => ({ monthId: created.id, name: i.name, plannedCents: i.plannedCents, sortOrder: i.sortOrder }))
        );
      }
      const groups = await tx.select().from(categoryGroups).where(eq(categoryGroups.monthId, source.id));
      for (const g of groups) {
        const [newGroup] = await tx
          .insert(categoryGroups)
          .values({ monthId: created.id, name: g.name, sortOrder: g.sortOrder })
          .returning();
        const items = await tx.select().from(lineItems).where(eq(lineItems.groupId, g.id));
        if (items.length) {
          await tx.insert(lineItems).values(
            items.map((i) => ({
              groupId: newGroup.id,
              name: i.name,
              plannedCents: i.plannedCents,
              sortOrder: i.sortOrder,
              sinkingFundId: i.sinkingFundId,
              favorite: i.favorite,
              isTransfer: i.isTransfer,
            }))
          );
        }
      }
      return created.id;
    });

    // Copied items that are linked to sinking funds add this month's money to them.
    // A goal only gets what it still needs (nothing once it's reached).
    if (mode === "copy") {
      const linked = await db
        .select({ id: lineItems.id, plannedCents: lineItems.plannedCents, fundId: lineItems.sinkingFundId })
        .from(lineItems)
        .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
        .where(and(eq(categoryGroups.monthId, newId), sql`${lineItems.sinkingFundId} is not null`));
      const before = previousMonth(year, month);
      const goals = (await loadFunds(db, before, { fundIds: [...new Set(linked.map((l) => l.fundId!))] })).filter((f) => f.kind === "goal" && f.targetCents !== null);
      for (const g of goals) {
        let room = Math.max(0, g.targetCents! - g.balanceCents);
        for (const l of linked.filter((x) => x.fundId === g.id)) {
          const planned = Math.min(l.plannedCents, room);
          room -= planned;
          if (planned !== l.plannedCents) await db.update(lineItems).set({ plannedCents: planned }).where(eq(lineItems.id, l.id));
        }
      }
      for (const l of linked) await syncLineItem(db, l.id);
    }
    // Leftover rolled over from last month's Month Close
    const prev = previousMonth(year, month);
    const prevRow = await findMonth(db, prev.year, prev.month);
    if (prevRow?.closedAt) await applyRollover(db, prevRow);

    const created = await findMonth(db, year, month);
    const budget = (await loadBudget(db, newId))!;
    return reply.status(201).send({ exists: true, ...budget, close: await closeFor(created, budget) });
  });

  app.delete("/api/months/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await requireMonth(db, id);
    await db.delete(budgetMonths).where(eq(budgetMonths.id, id));
    return reply.status(204).send();
  });

  // ---------- income items ----------

  app.post("/api/months/:id/income", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name, plannedCents: cents.default(0) }).parse(req.body);
    await requireMonth(db, id);
    await assertOpen(db, id);
    const sortOrder = await nextSortOrder(db, incomeItems, eq(incomeItems.monthId, id));
    const [row] = await db.insert(incomeItems).values({ monthId: id, ...body, sortOrder }).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/income/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: name.optional(), plannedCents: cents.optional() }).parse(req.body);
    const [item] = await db.select().from(incomeItems).where(eq(incomeItems.id, id));
    if (!item) throw notFound("Income item");
    await assertOpen(db, item.monthId);
    if (item.rolloverFromMonthId && body.plannedCents !== undefined && body.plannedCents !== item.plannedCents) {
      throw badRequest("This is last month's rollover. Reopen that month and close it again to change it.");
    }
    const [row] = await db.update(incomeItems).set(body).where(eq(incomeItems.id, id)).returning();
    return row;
  });

  app.delete("/api/income/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [item] = await db.select().from(incomeItems).where(eq(incomeItems.id, id));
    if (!item) throw notFound("Income item");
    await assertOpen(db, item.monthId);
    if (item.rolloverFromMonthId) throw badRequest("This is last month's rollover. Reopen that month and close it again to change it.");
    await db.delete(incomeItems).where(eq(incomeItems.id, id));
    return reply.status(204).send();
  });

  app.put("/api/months/:id/income/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = idList.parse(req.body);
    await requireMonth(db, id);
    await assertOpen(db, id);
    await db.transaction(async (tx) => {
      const current = await tx.select({ id: incomeItems.id }).from(incomeItems).where(eq(incomeItems.monthId, id));
      await applyOrder(tx, incomeItems, current.map((r) => r.id), ids);
    });
    return { ok: true };
  });

  // ---------- category groups ----------

  app.post("/api/months/:id/groups", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name }).parse(req.body);
    await requireMonth(db, id);
    await assertOpen(db, id);
    const sortOrder = await nextSortOrder(db, categoryGroups, eq(categoryGroups.monthId, id));
    const [row] = await db.insert(categoryGroups).values({ monthId: id, name: body.name, sortOrder }).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/groups/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name }).parse(req.body);
    await openCheck(db, await monthOfGroup(db, id));
    const [row] = await db.update(categoryGroups).set(body).where(eq(categoryGroups.id, id)).returning();
    if (!row) throw notFound("Group");
    return row;
  });

  app.delete("/api/groups/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await openCheck(db, await monthOfGroup(db, id));
    const deleted = await db
      .delete(categoryGroups)
      .where(eq(categoryGroups.id, id))
      .returning({ id: categoryGroups.id });
    if (!deleted.length) throw notFound("Group");
    return reply.status(204).send();
  });

  app.put("/api/months/:id/groups/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = idList.parse(req.body);
    await requireMonth(db, id);
    await assertOpen(db, id);
    await db.transaction(async (tx) => {
      const current = await tx
        .select({ id: categoryGroups.id })
        .from(categoryGroups)
        .where(eq(categoryGroups.monthId, id));
      await applyOrder(tx, categoryGroups, current.map((r) => r.id), ids);
    });
    return { ok: true };
  });

  // ---------- line items ----------

  app.post("/api/groups/:id/items", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ name, plannedCents: cents.default(0), sinkingFundId: z.number().int().positive().nullable().optional() })
      .parse(req.body);
    const group = await requireGroup(db, id);
    await assertOpen(db, group.monthId);
    await requireFund(db, body.sinkingFundId);
    const sortOrder = await nextSortOrder(db, lineItems, eq(lineItems.groupId, id));
    const [row] = await db
      .insert(lineItems)
      .values({ groupId: id, name: body.name, plannedCents: body.plannedCents, sinkingFundId: body.sinkingFundId ?? null, sortOrder })
      .returning();
    await syncLineItem(db, row.id);
    return reply.status(201).send(row);
  });

  // Edit a line item. Setting groupId moves it to another group in the same month (added at the end).
  app.patch("/api/items/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: name.optional(),
        plannedCents: cents.optional(),
        sinkingFundId: z.number().int().positive().nullable().optional(),
        groupId: z.number().int().positive().optional(),
        favorite: z.boolean().optional(),
        isTransfer: z.boolean().optional(),
      })
      .parse(req.body);

    const [item] = await db.select().from(lineItems).where(eq(lineItems.id, id));
    if (!item) throw notFound("Line item");
    await openCheck(db, await monthOfGroup(db, item.groupId));
    await requireFund(db, body.sinkingFundId);
    // Transfers aren't spending, but fund and goal items must keep counting toward their balance
    const willBeTransfer = body.isTransfer ?? item.isTransfer;
    const willHaveFund = body.sinkingFundId !== undefined ? body.sinkingFundId : item.sinkingFundId;
    if (willBeTransfer && willHaveFund) throw badRequest("Fund and goal items can't be transfer items");

    const changes: Partial<typeof lineItems.$inferInsert> = {
      name: body.name,
      plannedCents: body.plannedCents,
      sinkingFundId: body.sinkingFundId,
      favorite: body.favorite,
      isTransfer: body.isTransfer,
    };
    if (body.groupId !== undefined && body.groupId !== item.groupId) {
      const [from, to] = [await requireGroup(db, item.groupId), await requireGroup(db, body.groupId)];
      if (from.monthId !== to.monthId) throw badRequest("Can only move items within the same month");
      changes.groupId = to.id;
      changes.sortOrder = await nextSortOrder(db, lineItems, eq(lineItems.groupId, to.id));
    }
    const [row] = await db.update(lineItems).set(changes).where(eq(lineItems.id, id)).returning();
    await syncLineItem(db, id);
    return row;
  });

  app.delete("/api/items/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await openCheck(db, await monthOfItem(db, id));
    const deleted = await db.delete(lineItems).where(eq(lineItems.id, id)).returning({ id: lineItems.id });
    if (!deleted.length) throw notFound("Line item");
    return reply.status(204).send();
  });

  app.put("/api/groups/:id/items/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = idList.parse(req.body);
    const group = await requireGroup(db, id);
    await assertOpen(db, group.monthId);
    await db.transaction(async (tx) => {
      const current = await tx.select({ id: lineItems.id }).from(lineItems).where(eq(lineItems.groupId, id));
      await applyOrder(tx, lineItems, current.map((r) => r.id), ids);
    });
    return { ok: true };
  });
}
