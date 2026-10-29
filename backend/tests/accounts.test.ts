import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
});

const bank = (path: string, body: any) => {
  if (path === "/item/public_token/exchange") return { status: 200, json: { access_token: "access-1", item_id: "item-1" } };
  if (path === "/accounts/get")
    return {
      status: 200,
      json: {
        item: { institution_id: "ins_1", item_id: "item-1" },
        accounts: [
          { account_id: "chk", name: "Basic Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 3163.92, available: 3100 } },
          { account_id: "cc", name: "Tech Card", mask: "3333", type: "credit", subtype: "credit card", balances: { current: 1574.19, available: null } },
        ],
      },
    };
  if (path === "/institutions/get_by_id") return { status: 200, json: { institution: { name: "Stanford FCU" } } };
  return { status: 200, json: { link_token: "link" } };
};

describe("accounts", () => {
  it("lists banks and manual accounts with signed balances and totals", async () => {
    // No Plaid keys yet: Connect Account is hidden
    expect((await t.api("GET", "/api/accounts")).body).toMatchObject({ plaidReady: false, institutions: [], manual: [], assets: [] });

    t.plaid.respond = bank;
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
    await t.api("POST", "/api/plaid/exchange", { publicToken: "pub", institutionId: "ins_1" });
    await t.api("POST", "/api/accounts/manual", { name: "Cash Envelope", type: "cash", balanceCents: 20000 });
    const car = (await t.api("POST", "/api/accounts/manual", { name: "Car Loan", type: "loan", balanceCents: 850000 })).body;

    const a = (await t.api("GET", "/api/accounts")).body;
    expect(a.plaidReady).toBe(true);
    expect(a.institutions[0]).toMatchObject({ institutionName: "Stanford FCU", status: "ok", active: true });
    expect(a.institutions[0].accounts.map((x: any) => [x.name, x.balanceCents])).toEqual([
      ["Basic Checking", 316392],
      ["Tech Card", -157419],
    ]);
    expect(a.institutions[0].accessTokenEnc).toBeUndefined();
    expect(a.manual.map((m: any) => [m.name, m.signedCents, m.key])).toEqual([
      ["Cash Envelope", 20000, "manual:1"],
      ["Car Loan", -850000, `manual:${car.id}`],
    ]);
    expect(a.totals).toEqual({ haveCents: 336392, oweCents: 1007419, netCents: 336392 - 1007419, assetsCents: 0 });
  });

  it("edits and deletes a manual account; transactions marked with it keep their amounts", async () => {
    const acct = (await t.api("POST", "/api/accounts/manual", { name: "Wallet", type: "cash", balanceCents: 5000 })).body;
    expect((await t.api("POST", "/api/accounts/manual", { name: "X", type: "boat", balanceCents: 1 })).status).toBe(400);
    const edited = (await t.api("PATCH", `/api/accounts/manual/${acct.id}`, { balanceCents: 4200, name: "Cash" })).body;
    expect(edited).toMatchObject({ name: "Cash", balanceCents: 4200 });
    expect(new Date(edited.balanceUpdatedAt).getTime()).toBeGreaterThanOrEqual(new Date(acct.balanceUpdatedAt).getTime());

    const tx = (await t.api("POST", "/api/transactions", { date: "2026-10-02", merchant: "Farmers market", amountCents: 800, plaidAccountId: `manual:${acct.id}` })).body;
    expect((await t.api("GET", "/api/transactions")).body[0].account).toEqual({ name: "Cash", mask: null });

    expect((await t.api("DELETE", `/api/accounts/manual/${acct.id}`)).status).toBe(204);
    const after = (await t.api("GET", "/api/transactions")).body[0];
    expect(after).toMatchObject({ id: tx.id, amountCents: 800, plaidAccountId: null, account: null });
    expect((await t.api("DELETE", `/api/accounts/manual/${acct.id}`)).status).toBe(404);
  });

  it("assets count toward net worth but aren't accounts you can pick on a transaction", async () => {
    await t.api("POST", "/api/accounts/manual", { name: "Checking", type: "checking", balanceCents: 100000 });
    await t.api("POST", "/api/accounts/manual", { name: "House", type: "home", balanceCents: 35000000 });
    await t.api("POST", "/api/accounts/manual", { name: "Truck", type: "vehicle", balanceCents: 1800000 });
    await t.api("POST", "/api/accounts/manual", { name: "Mortgage", type: "loan", balanceCents: 21000000 });
    const a = (await t.api("GET", "/api/accounts")).body;
    expect(a.manual.map((m: any) => m.name)).toEqual(["Checking", "Mortgage"]);
    expect(a.assets.map((m: any) => [m.name, m.signedCents])).toEqual([
      ["House", 35000000],
      ["Truck", 1800000],
    ]);
    expect(a.totals).toEqual({ haveCents: 100000 + 35000000 + 1800000, oweCents: 21000000, netCents: 100000 + 35000000 + 1800000 - 21000000, assetsCents: 36800000 });
  });

  it("manual accounts are in backups", async () => {
    await t.api("POST", "/api/accounts/manual", { name: "Savings at Mom's", type: "savings", balanceCents: 30000 });
    const exported = (await t.api("GET", "/api/export")).body;
    await t.api("DELETE", "/api/accounts/manual/1");
    expect((await t.api("POST", "/api/import?confirm=replace", exported)).status).toBe(200);
    expect((await t.api("GET", "/api/accounts")).body.manual[0]).toMatchObject({ name: "Savings at Mom's", balanceCents: 30000 });
  });
});
