import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { plaidAccounts, plaidItems } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { PlaidError, type PlaidEnv } from "../lib/plaid.js";
import { idParam, isoDate } from "../lib/validation.js";
import { markItemError, monthsWaiting, syncAll } from "../lib/plaidSync.js";
import { autoSuggest } from "../lib/aiSuggest.js";

// Connecting banks through Plaid Link:
//  1. the page asks for a link token, opens Plaid's window, and the person signs in to their bank there
//  2. Plaid hands the page a one-time public token, which we swap for a long-lived access token
// Bank usernames and passwords only ever go to Plaid, never to this app.

function requireLogin(req: FastifyRequest) {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: { current: number | null; available: number | null };
}

const toCents = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 100));
const accountRow = (a: PlaidAccount) => ({
  name: a.name,
  officialName: a.official_name,
  mask: a.mask,
  type: a.type,
  subtype: a.subtype,
  currentBalanceCents: toCents(a.balances.current),
  availableBalanceCents: toCents(a.balances.available),
});

// First day of this month, in the server's time zone (where a new bank starts importing)
const startOfMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

export default async function plaidRoutes(app: FastifyInstance) {
  const { db, plaid } = app;

  const loadItem = async (id: number) => {
    const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, id) });
    if (!item) throw new HttpError(404, "Bank connection not found");
    return item;
  };

  // Call Plaid for a connected bank, recording "needs reconnect" problems on it
  async function callForItem<T>(item: typeof plaidItems.$inferSelect, path: string, body: Record<string, unknown> = {}) {
    const keys = await plaid.keysFor(item.env as PlaidEnv);
    try {
      return await plaid.call<T>(path, { access_token: plaid.decryptToken(item.accessTokenEnc), ...body }, keys);
    } catch (e) {
      if (e instanceof PlaidError) {
        const status = await markItemError(db, item.id, e);
        throw new HttpError(400, status === "login_required" ? `${item.institutionName} needs you to sign in again. Click Reconnect.` : `${e.message} (${e.code})`);
      }
      throw e;
    }
  }

  const listItems = async () => {
    const current = (await plaid.stored())?.env ?? null;
    const items = await db.query.plaidItems.findMany({
      with: { accounts: { orderBy: (a, { asc }) => [asc(a.id)] } },
      orderBy: (i, { asc }) => [asc(i.id)],
    });
    return items.map(({ accessTokenEnc: _t, cursor: _c, ...i }) => ({
      ...i,
      active: i.env === current, // connections from the other environment are paused
    }));
  };

  // A token for opening Plaid Link. With itemId: "update mode", to sign in again to that bank.
  app.post("/api/plaid/link-token", async (req) => {
    requireLogin(req);
    const { itemId } = z.object({ itemId: z.number().int().positive().optional() }).parse(req.body ?? {});
    const base = { client_name: "Zero Smart Budget", user: { client_user_id: "cory" }, country_codes: ["US"], language: "en" };
    try {
      if (itemId) {
        const item = await loadItem(itemId);
        const keys = await plaid.keysFor(item.env as PlaidEnv);
        const r = await plaid.call<{ link_token: string }>("/link/token/create", { ...base, access_token: plaid.decryptToken(item.accessTokenEnc) }, keys);
        return { linkToken: r.link_token };
      }
      const r = await plaid.call<{ link_token: string }>("/link/token/create", { ...base, products: ["transactions"], transactions: { days_requested: 730 } });
      return { linkToken: r.link_token };
    } catch (e) {
      if (e instanceof PlaidError) throw new HttpError(400, `${e.message} (${e.code})`);
      throw e;
    }
  });

  // After Link succeeds: swap the public token, save the bank and its accounts
  app.post("/api/plaid/exchange", async (req, reply) => {
    requireLogin(req);
    const body = z.object({ publicToken: z.string().min(1).max(500), institutionName: z.string().max(200).optional() }).parse(req.body);
    const keys = await plaid.keys();
    if (!keys) throw new HttpError(400, "Plaid isn't set up yet. Add your keys in Settings > Plaid.");
    let exchanged: { access_token: string; item_id: string };
    let accounts: { accounts: PlaidAccount[]; item: { institution_id: string | null } };
    try {
      exchanged = await plaid.call("/item/public_token/exchange", { public_token: body.publicToken }, keys);
      accounts = await plaid.call("/accounts/get", { access_token: exchanged.access_token }, keys);
    } catch (e) {
      if (e instanceof PlaidError) throw new HttpError(400, `${e.message} (${e.code})`);
      throw e;
    }
    const institutionId = accounts.item.institution_id;

    // Same bank connected twice (each connection counts toward Plaid's limit): undo the new one
    if (institutionId) {
      const existing = await db.query.plaidItems.findMany({
        where: and(eq(plaidItems.institutionId, institutionId), eq(plaidItems.env, keys.env)),
        with: { accounts: true },
      });
      const masks = new Set(accounts.accounts.map((a) => `${a.mask}|${a.name}`));
      const dupe = existing.find((i) => i.accounts.some((a) => masks.has(`${a.mask}|${a.name}`)));
      if (dupe) {
        await plaid.call("/item/remove", { access_token: exchanged.access_token }, keys).catch(() => {});
        throw new HttpError(409, `${dupe.institutionName} is already connected. If it stopped working, use Reconnect instead.`);
      }
    }

    let institutionName = body.institutionName?.trim() || "Bank";
    if (institutionId) {
      try {
        const r = await plaid.call<{ institution: { name: string } }>("/institutions/get_by_id", { institution_id: institutionId, country_codes: ["US"] }, keys);
        institutionName = r.institution.name;
      } catch {
        // keep the name Link gave us
      }
    }

    await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(plaidItems)
        .values({ itemId: exchanged.item_id, accessTokenEnc: plaid.encryptToken(exchanged.access_token), env: keys.env, institutionId, institutionName, importFrom: startOfMonth() })
        .returning({ id: plaidItems.id });
      if (accounts.accounts.length) {
        await tx.insert(plaidAccounts).values(accounts.accounts.map((a) => ({ plaidItemId: item.id, accountId: a.account_id, ...accountRow(a) })));
      }
    });
    return reply.status(201).send(await listItems());
  });

  app.get("/api/plaid/items", async () => listItems());

  // After signing in again (update mode): check it works and refresh the account list
  app.post("/api/plaid/items/:id/refresh", async (req) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const item = await loadItem(id);
    const r = await callForItem<{ accounts: PlaidAccount[] }>(item, "/accounts/get");
    await db.transaction(async (tx) => {
      for (const a of r.accounts) {
        await tx
          .insert(plaidAccounts)
          .values({ plaidItemId: item.id, accountId: a.account_id, ...accountRow(a) })
          .onConflictDoUpdate({ target: plaidAccounts.accountId, set: accountRow(a) });
      }
      await tx.update(plaidItems).set({ status: "ok", errorCode: null, errorMessage: null }).where(eq(plaidItems.id, item.id));
    });
    return listItems();
  });

  // Import transactions from every connected bank (also runs on a schedule)
  app.post("/api/plaid/sync", async (req) => {
    const results = await syncAll(db, plaid);
    if (results.some((r) => r.added)) autoSuggest(db, app.ai, req.log); // AI looks at new ones in the background (auto mode)
    return {
      results,
      added: results.reduce((n, r) => n + r.added, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      removed: results.reduce((n, r) => n + r.removed, 0),
      waiting: await monthsWaiting(db), // transactions in months with no budget yet
      items: await listItems(),
    };
  });

  // Change where importing starts. Moving it earlier re-reads the bank's history from the start
  // (already-imported transactions are matched, not duplicated).
  app.patch("/api/plaid/items/:id", async (req) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const { importFrom } = z.object({ importFrom: isoDate }).strict().parse(req.body);
    const item = await loadItem(id);
    await db
      .update(plaidItems)
      .set({ importFrom, ...(importFrom < item.importFrom ? { cursor: null } : {}) })
      .where(eq(plaidItems.id, id));
    return listItems();
  });

  // Turn importing on/off for one account (e.g. skip a savings account)
  app.patch("/api/plaid/accounts/:id", async (req) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const { importTransactions } = z.object({ importTransactions: z.boolean() }).strict().parse(req.body);
    const updated = await db.update(plaidAccounts).set({ importTransactions }).where(eq(plaidAccounts.id, id)).returning({ id: plaidAccounts.id });
    if (!updated.length) throw new HttpError(404, "Account not found");
    return listItems();
  });

  // Disconnect a bank: tell Plaid (frees up a connection), then forget it here.
  // Transactions already imported stay.
  app.delete("/api/plaid/items/:id", async (req, reply) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const item = await loadItem(id);
    try {
      const keys = await plaid.keysFor(item.env as PlaidEnv);
      await plaid.call("/item/remove", { access_token: plaid.decryptToken(item.accessTokenEnc) }, keys);
    } catch (e) {
      // Already gone at Plaid, or keys missing: still remove it here unless the person asked to keep it
      const { force } = z.object({ force: z.enum(["true", "false"]).optional() }).parse(req.query);
      if (force !== "true") {
        const why = e instanceof PlaidError ? `${e.message} (${e.code})` : (e as Error).message;
        throw new HttpError(409, `Plaid couldn't remove this connection: ${why}. Remove it here anyway?`);
      }
    }
    await db.delete(plaidItems).where(eq(plaidItems.id, id));
    return reply.status(204).send();
  });
}
