import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { budgetMonths, categoryGroups, incomeItems, lineItems, sinkingFunds } from "../db/schema.js";
import { loadBudget, nextSortOrder } from "../lib/budget.js";
import { STARTER_GROUPS, STARTER_INCOME } from "../lib/template.js";
import { syncLineItem } from "../lib/fundLedger.js";
import { monthIndex } from "../lib/calc.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
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
      };
    }
    return { exists: true, ...(await loadBudget(db, row.id)) };
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

      const income = await tx.select().from(incomeItems).where(eq(incomeItems.monthId, source.id));
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
            }))
          );
        }
      }
      return created.id;
    });

    // Copied items that are linked to sinking funds add this month's money to them
    if (mode === "copy") {
      const linked = await db
        .select({ id: lineItems.id })
        .from(lineItems)
        .innerJoin(categoryGroups, eq(lineItems.groupId, categoryGroups.id))
        .where(and(eq(categoryGroups.monthId, newId), sql`${lineItems.sinkingFundId} is not null`));
      for (const l of linked) await syncLineItem(db, l.id);
    }

    return reply.status(201).send({ exists: true, ...(await loadBudget(db, newId)) });
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
    const sortOrder = await nextSortOrder(db, incomeItems, eq(incomeItems.monthId, id));
    const [row] = await db.insert(incomeItems).values({ monthId: id, ...body, sortOrder }).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/income/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: name.optional(), plannedCents: cents.optional() }).parse(req.body);
    const [row] = await db.update(incomeItems).set(body).where(eq(incomeItems.id, id)).returning();
    if (!row) throw notFound("Income item");
    return row;
  });

  app.delete("/api/income/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await db.delete(incomeItems).where(eq(incomeItems.id, id)).returning({ id: incomeItems.id });
    if (!deleted.length) throw notFound("Income item");
    return reply.status(204).send();
  });

  app.put("/api/months/:id/income/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = idList.parse(req.body);
    await requireMonth(db, id);
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
    const sortOrder = await nextSortOrder(db, categoryGroups, eq(categoryGroups.monthId, id));
    const [row] = await db.insert(categoryGroups).values({ monthId: id, name: body.name, sortOrder }).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/groups/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name }).parse(req.body);
    const [row] = await db.update(categoryGroups).set(body).where(eq(categoryGroups.id, id)).returning();
    if (!row) throw notFound("Group");
    return row;
  });

  app.delete("/api/groups/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
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
    await requireGroup(db, id);
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
      })
      .parse(req.body);

    const [item] = await db.select().from(lineItems).where(eq(lineItems.id, id));
    if (!item) throw notFound("Line item");
    await requireFund(db, body.sinkingFundId);

    const changes: Partial<typeof lineItems.$inferInsert> = {
      name: body.name,
      plannedCents: body.plannedCents,
      sinkingFundId: body.sinkingFundId,
      favorite: body.favorite,
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
    const deleted = await db.delete(lineItems).where(eq(lineItems.id, id)).returning({ id: lineItems.id });
    if (!deleted.length) throw notFound("Line item");
    return reply.status(204).send();
  });

  app.put("/api/groups/:id/items/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = idList.parse(req.body);
    await requireGroup(db, id);
    await db.transaction(async (tx) => {
      const current = await tx.select({ id: lineItems.id }).from(lineItems).where(eq(lineItems.groupId, id));
      await applyOrder(tx, lineItems, current.map((r) => r.id), ids);
    });
    return { ok: true };
  });
}
