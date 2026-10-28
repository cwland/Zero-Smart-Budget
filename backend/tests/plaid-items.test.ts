import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());

// A small fake bank on the fake Plaid
let removed: string[] = [];
let accountsFail = "";
const accounts = (suffix = "") => [
  { account_id: "acc-chk" + suffix, name: "Plaid Checking", official_name: "Plaid Gold Standard 0% Interest Checking", mask: suffix ? "1111" : "0000", type: "depository", subtype: "checking", balances: { current: 110.5, available: 100 } },
  { account_id: "acc-cc" + suffix, name: "Plaid Credit Card", official_name: null, mask: suffix ? "4444" : "3333", type: "credit", subtype: "credit card", balances: { current: 410, available: null } },
];
function fakeBank(path: string, body: any) {
  switch (path) {
    case "/link/token/create":
      return { status: 200, json: { link_token: body.access_token ? "link-update" : "link-new" } };
    case "/item/public_token/exchange":
      return { status: 200, json: { access_token: "access-" + body.public_token, item_id: "item-" + body.public_token } };
    case "/accounts/get":
      if (accountsFail) return { status: 400, json: { error_type: "ITEM_ERROR", error_code: accountsFail, error_message: "the login details of this item have changed" } };
      return { status: 200, json: { accounts: body.access_token === "access-pub-2" ? accounts("-2") : body.access_token === "access-pub-other" ? accounts("-o") : accounts(), item: { institution_id: body.access_token === "access-pub-other" ? "ins_2" : "ins_109508", item_id: "x" } } };
    case "/institutions/get_by_id":
      return { status: 200, json: { institution: { name: body.institution_id === "ins_2" ? "Other Bank" : "First Platypus Bank" } } };
    case "/item/remove":
      removed.push(body.access_token);
      return { status: 200, json: {} };
  }
  return { status: 404, json: { error_code: "NOT_FOUND" } };
}

beforeEach(async () => {
  await t.reset();
  await t.login();
  removed = [];
  accountsFail = "";
  t.plaid.respond = fakeBank;
  await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx", productionSecret: "prd" });
});

describe("connecting banks", () => {
  it("creates link tokens: new connection asks for transactions, update mode passes the access token", async () => {
    expect((await t.api("POST", "/api/plaid/link-token", {})).body).toEqual({ linkToken: "link-new" });
    expect(t.plaid.calls[0].body).toMatchObject({ products: ["transactions"], user: { client_user_id: "cory" } });
    const items = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" })).body;
    expect((await t.api("POST", "/api/plaid/link-token", { itemId: items[0].id })).body).toEqual({ linkToken: "link-update" });
    const last = t.plaid.calls.at(-1)!.body;
    expect(last.access_token).toBe("access-pub-1");
    expect(last.products).toBeUndefined();
  });

  it("exchange saves the bank (token encrypted) and its accounts with balances in cents", async () => {
    const res = await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1", institutionName: "From Link" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(item).toMatchObject({ institutionName: "First Platypus Bank", env: "sandbox", status: "ok", active: true });
    expect(item.accessTokenEnc).toBeUndefined();
    expect(item.accounts.map((a: any) => [a.name, a.mask, a.currentBalanceCents, a.availableBalanceCents, a.importTransactions])).toEqual([
      ["Plaid Checking", "0000", 11050, 10000, true],
      ["Plaid Credit Card", "3333", 41000, null, true],
    ]);
    const raw = JSON.stringify((await t.db.execute(sql`select access_token_enc from plaid_items`)).rows);
    expect(raw).not.toContain("access-pub-1");
  });

  it("refuses to connect the same bank twice and frees the duplicate at Plaid", async () => {
    await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" });
    const dupe = await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1b" });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toMatch(/already connected/);
    expect(removed).toEqual(["access-pub-1b"]);
    // A different bank is fine; so are different accounts at the same bank (e.g. a spouse's login)
    expect((await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-other" })).status).toBe(201);
    expect((await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-2" })).status).toBe(201);
    expect((await t.api("GET", "/api/plaid/items")).body).toHaveLength(3);
  });

  it("turns importing off for an account", async () => {
    const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" })).body;
    const cc = item.accounts[1];
    const after = (await t.api("PATCH", `/api/plaid/accounts/${cc.id}`, { importTransactions: false })).body;
    expect(after[0].accounts[1].importTransactions).toBe(false);
    expect((await t.api("PATCH", "/api/plaid/accounts/9999", { importTransactions: false })).status).toBe(404);
  });

  it("marks a bank as needing reconnect, and refresh clears it after signing in again", async () => {
    const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" })).body;
    accountsFail = "ITEM_LOGIN_REQUIRED";
    const res = await t.api("POST", `/api/plaid/items/${item.id}/refresh`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sign in again/);
    expect((await t.api("GET", "/api/plaid/items")).body[0]).toMatchObject({ status: "login_required", errorCode: "ITEM_LOGIN_REQUIRED" });
    accountsFail = "";
    const ok = (await t.api("POST", `/api/plaid/items/${item.id}/refresh`)).body;
    expect(ok[0]).toMatchObject({ status: "ok", errorCode: null });
  });

  it("a bank connected in Sandbox stays tied to Sandbox keys and shows as paused in Production", async () => {
    await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" });
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "production" });
    const [item] = (await t.api("GET", "/api/plaid/items")).body;
    expect(item.active).toBe(false);
    await t.api("POST", `/api/plaid/items/${item.id}/refresh`);
    expect(t.plaid.calls.at(-1)!.url).toBe("https://sandbox.plaid.com/accounts/get");
    expect(t.plaid.calls.at(-1)!.body.secret).toBe("sbx");
  });

  it("removing tells Plaid first; if Plaid can't, it asks before removing locally", async () => {
    const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" })).body;
    t.plaid.respond = (p, b) => (p === "/item/remove" ? { status: 400, json: { error_code: "ITEM_NOT_FOUND", error_message: "item not found" } } : fakeBank(p, b));
    const res = await t.api("DELETE", `/api/plaid/items/${item.id}`);
    expect(res.status).toBe(409);
    expect((await t.api("GET", "/api/plaid/items")).body).toHaveLength(1);
    expect((await t.api("DELETE", `/api/plaid/items/${item.id}?force=true`)).status).toBe(204);
    expect((await t.api("GET", "/api/plaid/items")).body).toHaveLength(0);

    t.plaid.respond = fakeBank;
    const [again] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub-1" })).body;
    expect((await t.api("DELETE", `/api/plaid/items/${again.id}`)).status).toBe(204);
    expect(removed).toContain("access-pub-1");
    expect((await t.db.execute(sql`select count(*)::int as n from plaid_accounts`)).rows[0]).toEqual({ n: 0 });
  });

  it("needs keys and a login", async () => {
    await t.api("DELETE", "/api/settings/plaid");
    expect((await t.api("POST", "/api/plaid/link-token", {})).body.error).toMatch(/isn't set up/);
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    t.setToken("");
    expect((await t.api("POST", "/api/plaid/link-token", {}, { "x-api-key": key })).status).toBe(403);
    expect((await t.api("GET", "/api/plaid/items", undefined, { "x-api-key": key })).status).toBe(200);
  });
});
