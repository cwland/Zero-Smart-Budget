import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
});

const features = async () => (await t.api("GET", "/api/settings/features")).body;
const turn = (changes: object) => t.api("PUT", "/api/settings/features", changes);

function bank(path: string) {
  if (path === "/item/public_token/exchange") return { status: 200, json: { access_token: "access-1", item_id: "item-1" } };
  if (path === "/accounts/get")
    return { status: 200, json: { accounts: [{ account_id: "chk", name: "Checking", official_name: null, mask: "0000", type: "depository", subtype: "checking", balances: { current: 100, available: 100 } }], item: { institution_id: "ins_1" } } };
  if (path === "/institutions/get_by_id") return { status: 200, json: { institution: { name: "Test Bank" } } };
  if (path === "/link/token/create") return { status: 200, json: { link_token: "link-1" } };
  if (path === "/transactions/sync") return { status: 200, json: { added: [], modified: [], removed: [], next_cursor: "c", has_more: false, accounts: [] } };
  return { status: 404, json: {} };
}

describe("feature switches", () => {
  it("start off when nothing is set up, and on for what is", async () => {
    expect(await features()).toEqual({ plaid: false, ai: false, apiKeys: false });
    t.plaid.respond = bank;
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
    await t.api("PUT", "/api/settings/ai", { enabled: false, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    await t.api("POST", "/api/keys", { name: "n8n" });
    expect(await features()).toEqual({ plaid: true, ai: true, apiKeys: true });
  });

  it("only flipped switches are stored; the rest follow what's set up", async () => {
    await turn({ apiKeys: true });
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
    expect(await features()).toEqual({ plaid: true, ai: false, apiKeys: true });
    expect((await turn({ plaid: false })).body).toEqual({ plaid: false, ai: false, apiKeys: true });
    expect((await t.api("PUT", "/api/settings/features", { nope: true })).status).toBe(400);
  });

  it("signed in only, never with an API key", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n", access: "read_add" })).body.key;
    t.setToken("");
    expect((await t.api("GET", "/api/settings/features", undefined, { "x-api-key": key })).status).toBe(403);
    expect((await t.api("PUT", "/api/settings/features", { apiKeys: true }, { "x-api-key": key })).status).toBe(403);
  });

  it("API keys off: every key is refused and logged; keys are kept", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n", access: "read_add" })).body.key;
    const token = t.getToken();
    t.setToken("");
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": key })).status).toBe(200);
    t.setToken(token);
    await turn({ apiKeys: false });
    t.setToken("");
    const r = await t.api("GET", "/api/months", undefined, { "x-api-key": key });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/turned off/);
    t.setToken(token);
    expect((await t.api("GET", "/api/keys")).body).toHaveLength(1);
    const logs = (await t.api("GET", "/api/logs?category=api")).body;
    expect(logs.map((l: any) => l.event)).toEqual(["Refused GET /api/months: API keys are turned off", "API keys turned off"]);
    await turn({ apiKeys: true });
    t.setToken("");
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": key })).status).toBe(200);
  });

  it("Plaid off: no linking or syncing; banks stay, shown paused", async () => {
    t.plaid.respond = bank;
    await t.api("PUT", "/api/settings/plaid", { clientId: "cid", env: "sandbox", sandboxSecret: "sbx" });
    const [item] = (await t.api("POST", "/api/plaid/exchange", { publicToken: "pub" })).body;
    await turn({ plaid: false });
    for (const [m, p, b] of [["POST", "/api/plaid/link-token", {}], ["POST", "/api/plaid/exchange", { publicToken: "pub" }], ["POST", `/api/plaid/items/${item.id}/refresh`, {}], ["POST", "/api/plaid/sync", {}]] as const) {
      const r = await t.api(m, p, b);
      expect(r.status, p).toBe(409);
      expect(r.body.error).toMatch(/Plaid is turned off/);
    }
    const items = (await t.api("GET", "/api/plaid/items")).body;
    expect(items.map((i: any) => [i.institutionName, i.active])).toEqual([["Test Bank", false]]);
    const accounts = (await t.api("GET", "/api/accounts")).body;
    expect([accounts.plaidOn, accounts.plaidReady, accounts.institutions[0].active]).toEqual([false, false, false]);
    expect((await t.api("PATCH", `/api/plaid/items/${item.id}`, { importFrom: "2026-10-01" })).status).toBe(200);
    await turn({ plaid: true });
    expect((await t.api("POST", "/api/plaid/sync")).status).toBe(200);
    expect((await t.api("GET", "/api/accounts")).body.institutions[0].active).toBe(true);
  });

  it("AI off: hidden and not used, the services kept", async () => {
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    expect((await t.api("GET", "/api/ai/status")).body.enabled).toBe(true);
    await turn({ ai: false });
    expect((await t.api("GET", "/api/ai/status")).body).toEqual({ enabled: false, mode: null });
    expect((await t.api("POST", "/api/transactions/ai-suggest", {})).body.error).toMatch(/isn't turned on/);
    const s = (await t.api("GET", "/api/settings/ai")).body.settings;
    expect([s.available, s.ready, s.enabled, s.services.length]).toEqual([false, true, true, 1]);
    await turn({ ai: true });
    expect((await t.api("GET", "/api/ai/status")).body.enabled).toBe(true);
  });
});
