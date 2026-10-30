import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());

// A fake bank whose /transactions/sync returns whatever the test queues up for the next call
type Tx = { transaction_id: string; account_id: string; amount: number; date: string; name: string; merchant_name?: string | null; pending: boolean; pending_transaction_id?: string | null };
let pages: { added?: Tx[]; modified?: Tx[]; removed?: string[]; has_more?: boolean }[] = [];
let syncCursors: (string | undefined)[] = [];
let mutateOnce = false;
let n = 0;
const tx = (id: string, amount: number, date: string, extra: Partial<Tx> = {}): Tx => ({ transaction_id: id, account_id: "chk", amount, date, name: "POS " + id, merchant_name: null, pending: false, ...extra });

function bank(path: string, body: any) {
  if (path === "/item/public_token/exchange") return { status: 200, json: { access_token: "access-1", item_id: "item-1" } };
  if (path === "/accounts/get")
    return {
      status: 200,
      json: {
        accounts: [
          { account_id: "chk", name: "Checking", official_name: null, mask: "0000", type: "depository", subtype: "checking", balances: { current: 100, available: 100 } },
          { account_id: "sav", name: "Savings", official_name: null, mask: "1111", type: "depository", subtype: "savings", balances: { current: 500, available: 500 } },
        ],
        item: { institution_id: "ins_1" },
      },
    };
  if (path === "/institutions/get_by_id") return { status: 200, json: { institution: { name: "Test Bank" } } };
  if (path === "/transactions/sync") {
    syncCursors.push(body.cursor);
    if (mutateOnce) {
      mutateOnce = false;
      return { status: 400, json: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "mutation" } };
    }
    const p = pages.shift() ?? {};
    n++;
    return {
      status: 200,
      json: {
        added: p.added ?? [],
        modified: p.modified ?? [],
        removed: (p.removed ?? []).map((id) => ({ transaction_id: id, account_id: "chk" })),
        next_cursor: "cur-" + n,
        has_more: !!p.has_more,
        accounts: [{ account_id: "chk", balances: { current: 77.7, available: 70 } }],
      },
    };
  }
  return { status: 404, json: {} };
}

let itemId = 0;
beforeEach(async () => {
  await t.reset();
  await t.login();
  pages = [];
  syncCursors = [];
  mutateOnce = false;
  n = 0;
  t.plaid.respond = bank;
  await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
  const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub" })).body;
  itemId = item.id;
  await t.api("PATCH", `/api/plaid/items/${itemId}`, { importFrom: "2026-10-01" });
});

const sync = async () => (await t.api("POST", "/api/plaid/sync")).body;
const list = async () => (await t.api("GET", "/api/transactions?from=2026-01-01&to=2026-12-31")).body;

describe("importing bank transactions", () => {
  it("new bank starts importing from the first of this month", async () => {
    await t.reset();
    await t.login();
    t.plaid.respond = bank;
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
    const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub" })).body;
    expect(item.importFrom).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("imports expenses and income unassigned, across pages, with the account and balances", async () => {
    pages = [
      { added: [tx("a", 12.5, "2026-10-05", { merchant_name: "Chipotle" })], has_more: true },
      { added: [tx("b", -2500, "2026-10-15", { name: "PAYROLL ACME" })] },
    ];
    const res = await sync();
    expect(res).toMatchObject({ added: 2, updated: 0, removed: 0 });
    expect(syncCursors).toEqual([undefined, "cur-1"]);
    const rows = await list();
    expect(rows.map((r: any) => [r.merchant, r.amountCents, r.type, r.pending, r.splits.length])).toEqual([
      ["PAYROLL ACME", 250000, "income", false, 0],
      ["Chipotle", 1250, "expense", false, 0],
    ]);
    expect(rows[1].account).toEqual({ name: "Checking", mask: "0000" });
    const item = res.items[0];
    expect(item.lastSyncedAt).toBeTruthy();
    expect(item.accounts[0].currentBalanceCents).toBe(7770);

    // Next sync continues from the saved cursor and doesn't duplicate
    pages = [{ added: [tx("a", 12.5, "2026-10-05")] }];
    expect((await sync()).added).toBe(0);
    expect(syncCursors.at(-1)).toBe("cur-2");
    expect(await list()).toHaveLength(2);
  });

  it("skips history before the import date, accounts turned off, and $0 rows", async () => {
    const savings = (await t.api("GET", "/api/plaid/items")).body[0].accounts.find((a: any) => a.name === "Savings");
    await t.api("PATCH", `/api/plaid/accounts/${savings.id}`, { importTransactions: false });
    pages = [{ added: [tx("old", 5, "2026-09-30"), tx("sav", 5, "2026-10-02", { account_id: "sav" }), tx("zero", 0, "2026-10-02"), tx("ok", 5, "2026-10-02")] }];
    expect((await sync()).added).toBe(1);
    expect((await list()).map((r: any) => r.merchant)).toEqual(["POS ok"]);
  });

  it("a pending charge that posts updates the same row and keeps its budget item", async () => {
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
    const dining = oct.groups.flatMap((g: any) => g.items).find((i: any) => i.name === "Dining Out");
    pages = [{ added: [tx("p1", 40, "2026-10-10", { pending: true, merchant_name: "Thai Place" })] }];
    await sync();
    const [row] = await list();
    expect(row.pending).toBe(true);
    await t.api("PUT", `/api/transactions/${row.id}`, { date: row.date, merchant: "Thai Place", amountCents: 4000, type: "expense", splits: [{ lineItemId: dining.id, amountCents: 4000 }] });

    // Posts with a tip added; Plaid sends a new id pointing at the pending one, then removes the pending one
    pages = [{ added: [tx("posted1", 48, "2026-10-11", { pending_transaction_id: "p1", merchant_name: "Thai Place" })], removed: ["p1"] }];
    expect(await sync()).toMatchObject({ added: 0, updated: 1, removed: 0 });
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row.id, pending: false, amountCents: 4800, date: "2026-10-11", plaidTransactionId: "posted1" });
    expect(after[0].splits).toEqual([expect.objectContaining({ lineItemId: dining.id, amountCents: 4800 })]);
  });

  it("modified: new amount on a split clears the split; moving to another month unassigns", async () => {
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
    const items = oct.groups.flatMap((g: any) => g.items);
    pages = [{ added: [tx("m1", 100, "2026-10-20"), tx("m2", 30, "2026-10-31")] }];
    await sync();
    const rows = await list();
    const m1 = rows.find((r: any) => r.plaidTransactionId === "m1");
    const m2 = rows.find((r: any) => r.plaidTransactionId === "m2");
    await t.api("PUT", `/api/transactions/${m1.id}`, { date: m1.date, merchant: "Renamed here", amountCents: 10000, type: "expense", splits: [{ lineItemId: items[0].id, amountCents: 6000 }, { lineItemId: items[1].id, amountCents: 4000 }] });
    await t.api("PUT", `/api/transactions/${m2.id}`, { date: m2.date, merchant: m2.merchant, amountCents: 3000, type: "expense", splits: [{ lineItemId: items[0].id, amountCents: 3000 }] });

    pages = [{ modified: [tx("m1", 110, "2026-10-20"), tx("m2", 30, "2026-11-01")] }];
    expect((await sync()).updated).toBe(2);
    const now = await list();
    const n1 = now.find((r: any) => r.id === m1.id);
    const n2 = now.find((r: any) => r.id === m2.id);
    expect(n1).toMatchObject({ amountCents: 11000, merchant: "Renamed here" });
    expect(n1.splits).toEqual([]);
    expect(n2).toMatchObject({ date: "2026-11-01" });
    expect(n2.splits).toEqual([]);
  });

  it("removed: a pending charge that dropped off is deleted", async () => {
    pages = [{ added: [tx("auth", 1, "2026-10-03", { pending: true })] }];
    await sync();
    pages = [{ removed: ["auth", "never-imported"] }];
    expect((await sync()).removed).toBe(1);
    expect(await list()).toHaveLength(0);
  });

  it("restarts when the bank changes mid-sync", async () => {
    mutateOnce = true;
    pages = [{ added: [tx("x", 9, "2026-10-09")] }];
    expect((await sync()).added).toBe(1);
    expect(syncCursors).toEqual([undefined, undefined]);
  });

  it("moving the import date earlier re-reads history without duplicates", async () => {
    pages = [{ added: [tx("a", 5, "2026-10-02")] }];
    await sync();
    await t.api("PATCH", `/api/plaid/items/${itemId}`, { importFrom: "2026-09-01" });
    pages = [{ added: [tx("sep", 7, "2026-09-15"), tx("a", 5, "2026-10-02")] }];
    expect(await sync()).toMatchObject({ added: 1, updated: 0 }); // the October one is unchanged, so not counted
    expect(syncCursors.at(-1)).toBeUndefined();
    expect(await list()).toHaveLength(2);
  });

  it("a bank needing sign-in is reported and marked, others still sync", async () => {
    t.plaid.respond = (p, b) => (p === "/transactions/sync" ? { status: 400, json: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" } } : bank(p, b));
    const res = await sync();
    expect(res.results[0].error).toMatch(/sign in again/);
    expect(res.items[0].status).toBe("login_required");
  });

  it("banks from the other environment are skipped; Quick Assign suggests on imports", async () => {
    // Teach a merchant, then import it
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
    const groceries = oct.groups.flatMap((g: any) => g.items).find((i: any) => i.name === "Groceries");
    await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "Trader Joe's", amountCents: 100, splits: [{ lineItemId: groceries.id, amountCents: 100 }] });
    pages = [{ added: [tx("tj", 50, "2026-10-08", { merchant_name: "Trader Joe's" })] }];
    await sync();
    const tj = (await list()).find((r: any) => r.plaidTransactionId === "tj");
    expect(tj.suggestion).toMatchObject({ itemName: "Groceries" });

    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "production", productionSecret: "prd" });
    expect((await sync()).results).toEqual([]);
  });

  it("restore keeps the Plaid ids, so the next sync doesn't duplicate", async () => {
    pages = [{ added: [tx("keep", 5, "2026-10-02")] }];
    await sync();
    const backup = (await t.api("GET", "/api/export")).body;
    expect((await t.api("POST", "/api/import?confirm=replace", backup)).status).toBe(200);
    pages = [{ added: [tx("keep", 5, "2026-10-02")] }];
    expect((await sync()).added).toBe(0);
    expect(await list()).toHaveLength(1);
  });

  it("works with an API key (e.g. n8n kicking off a sync)", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    t.setToken("");
    expect((await t.api("POST", "/api/plaid/sync", undefined, { "x-api-key": key })).status).toBe(200);
  });

  it("reports months that have imported transactions but no budget yet", async () => {
    await t.api("PATCH", `/api/plaid/items/${itemId}`, { importFrom: "2026-07-01" });
    await t.api("POST", "/api/months/2026/10", { mode: "template" });
    pages = [{ added: [tx("j1", 1, "2026-07-05"), tx("j2", 2, "2026-07-20"), tx("a1", 3, "2026-08-01"), tx("o1", 4, "2026-10-01")] }];
    const res = await sync();
    expect(res.waiting).toEqual([{ year: 2026, month: 7, count: 2 }, { year: 2026, month: 8, count: 1 }]);
    const july = (await t.api("GET", "/api/months/2026/7")).body;
    expect(july).toMatchObject({ exists: false, waitingTransactions: 2 });
    expect((await t.api("GET", "/api/months/2026/9")).body.waitingTransactions).toBe(0);
    await t.api("POST", "/api/months/2026/7", { mode: "template" });
    expect((await sync()).waiting).toEqual([{ year: 2026, month: 8, count: 1 }]);
  });

  it("a transaction you deleted stays deleted when the bank sends it again", async () => {
    pages = [{ added: [tx("del", 5, "2026-10-02")] }];
    await sync();
    const [row] = await list();
    await t.api("DELETE", `/api/transactions/${row.id}`);
    await t.api("PATCH", `/api/plaid/items/${itemId}`, { importFrom: "2026-09-01" }); // forces a full re-read
    pages = [{ added: [tx("del", 5, "2026-10-02")] }];
    expect((await sync()).added).toBe(0);
    expect(await list()).toHaveLength(0);
    expect((await t.api("GET", "/api/transactions?deleted=true")).body).toHaveLength(1);
  });
});
