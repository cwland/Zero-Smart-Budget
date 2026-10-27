import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import {
  budgetMonths,
  categoryGroups,
  incomeItems,
  lineItems,
  sinkingFunds,
  transactions,
  transactionSplits,
} from "../db/schema.js";

// Everything except the login and API keys, as one JSON file
export default async function exportRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/api/export", async (_req, reply) => {
    const data = {
      app: "Cory's Dollar",
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      months: await db.select().from(budgetMonths).orderBy(asc(budgetMonths.id)),
      incomeItems: await db.select().from(incomeItems).orderBy(asc(incomeItems.id)),
      groups: await db.select().from(categoryGroups).orderBy(asc(categoryGroups.id)),
      lineItems: await db.select().from(lineItems).orderBy(asc(lineItems.id)),
      sinkingFunds: await db.select().from(sinkingFunds).orderBy(asc(sinkingFunds.id)),
      transactions: await db.select().from(transactions).orderBy(asc(transactions.id)),
      transactionSplits: await db.select().from(transactionSplits).orderBy(asc(transactionSplits.id)),
    };
    const stamp = data.exportedAt.slice(0, 10);
    return reply
      .header("Content-Disposition", `attachment; filename="corys-dollar-${stamp}.json"`)
      .send(data);
  });
}
