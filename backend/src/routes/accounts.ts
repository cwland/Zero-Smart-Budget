import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { manualAccounts, transactions } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { idParam, name } from "../lib/validation.js";

// The Accounts page (like EveryDollar's): banks connected through Plaid, plus accounts you track
// by hand. Balances are shown signed: money you have is positive, money you owe is negative.

const MANUAL_TYPES = ["checking", "savings", "cash", "credit", "loan", "investment", "other"] as const;
const isDebt = (type: string) => type === "credit" || type === "loan";
// Manual accounts are picked on a transaction as "manual:<id>" (stored with the bank account ids)
export const manualAccountKey = (id: number) => `manual:${id}`;

export default async function accountRoutes(app: FastifyInstance) {
  const { db, plaid } = app;

  app.get("/api/accounts", async () => {
    // Plaid is ready when keys and the current environment's secret are saved
    const s = await plaid.stored();
    const plaidReady = !!s?.clientId && !!(await plaid.savedSecret(s.env));
    const items = await db.query.plaidItems.findMany({
      with: { accounts: { orderBy: (a, { asc }) => [asc(a.id)] } },
      orderBy: (i, { asc }) => [asc(i.id)],
    });
    const institutions = items.map(({ accessTokenEnc: _t, cursor: _c, accounts, ...i }) => ({
      ...i,
      active: i.env === (s?.env ?? null),
      accounts: accounts.map((a) => ({
        ...a,
        balanceCents: a.currentBalanceCents === null ? null : isDebt(a.type) ? -a.currentBalanceCents : a.currentBalanceCents,
      })),
    }));
    const manual = (await db.select().from(manualAccounts).orderBy(asc(manualAccounts.sortOrder), asc(manualAccounts.id))).map((m) => ({
      ...m,
      key: manualAccountKey(m.id),
      signedCents: isDebt(m.type) ? -m.balanceCents : m.balanceCents,
    }));

    const all = [...institutions.flatMap((i) => i.accounts.map((a) => a.balanceCents ?? 0)), ...manual.map((m) => m.signedCents)];
    const haveCents = all.filter((n) => n > 0).reduce((t, n) => t + n, 0);
    const oweCents = -all.filter((n) => n < 0).reduce((t, n) => t + n, 0);
    return { plaidReady, institutions, manual, totals: { haveCents, oweCents, netCents: haveCents - oweCents } };
  });

  const manualBody = z.object({
    name,
    type: z.enum(MANUAL_TYPES),
    // For credit cards and loans: the amount owed
    balanceCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  });

  app.post("/api/accounts/manual", async (req, reply) => {
    const body = manualBody.parse(req.body);
    const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${manualAccounts.sortOrder}), -1) + 1` }).from(manualAccounts);
    const [row] = await db.insert(manualAccounts).values({ ...body, sortOrder: Number(next) }).returning();
    return reply.status(201).send(row);
  });

  app.patch("/api/accounts/manual/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = manualBody.partial().parse(req.body);
    const changes = { ...body, ...(body.balanceCents !== undefined ? { balanceUpdatedAt: new Date() } : {}) };
    const [row] = await db.update(manualAccounts).set(changes).where(eq(manualAccounts.id, id)).returning();
    if (!row) throw notFound("Account");
    return row;
  });

  // Transactions that were marked with this account keep their amounts; they just lose the label
  app.delete("/api/accounts/manual/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.delete(manualAccounts).where(eq(manualAccounts.id, id)).returning();
    if (!row) throw notFound("Account");
    await db.update(transactions).set({ plaidAccountId: null }).where(eq(transactions.plaidAccountId, manualAccountKey(id)));
    return reply.status(204).send();
  });
}
