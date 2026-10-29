import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
  await t.api("POST", "/api/months/2026/10", { mode: "fresh" });
});

const makeKey = async (access?: string) => (await t.api("POST", "/api/keys", { name: `k-${access}`, ...(access ? { access } : {}) })).body;
const withKey = (key: string) => (method: string, url: string, payload?: object) => t.api(method, url, payload, { "x-api-key": key, authorization: "" });
const tx = { date: "2026-10-05", merchant: "Costco", amountCents: 4567 };

describe("API key access", () => {
  it("is chosen when the key is made and shown in the list", async () => {
    const k = await makeKey("read");
    expect(k).toMatchObject({ access: "read" });
    expect((await t.api("GET", "/api/keys")).body.map((x: any) => x.access)).toEqual(["read"]);
    expect((await t.api("POST", "/api/keys", { name: "x", access: "everything" })).status).toBe(400);
    expect((await makeKey()).access).toBe("read_add"); // default
  });

  it("read only: can look, can't add or change anything", async () => {
    const as = withKey((await makeKey("read")).key);
    for (const url of ["/api/months", "/api/months/2026/10", "/api/transactions", "/api/funds", "/api/accounts"]) expect((await as("GET", url)).status, url).toBe(200);
    const r = await as("POST", "/api/transactions", tx);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Read only/);
  });

  it("add transactions: can add, can't read", async () => {
    const as = withKey((await makeKey("add")).key);
    expect((await as("POST", "/api/transactions", tx)).status).toBe(201);
    const r = await as("GET", "/api/transactions");
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/can only add transactions/);
    expect((await as("GET", "/api/months")).status).toBe(403);
  });

  it("read + add: both, but never edits the plan, transactions, funds or settings", async () => {
    const as = withKey((await makeKey("read_add")).key);
    const added = (await as("POST", "/api/transactions", tx)).body;
    expect((await as("GET", `/api/transactions/${added.id}`)).status).toBe(200);
    const month = (await t.api("GET", "/api/months/2026/10")).body;
    const g = (await t.api("POST", `/api/months/${month.id}/groups`, { name: "Spending" })).body;
    const item = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Food", plannedCents: 100 })).body;
    expect((await as("GET", "/api/months/2026/10")).status).toBe(200);
    const denied: [string, string, object?][] = [
      ["PUT", `/api/transactions/${added.id}`, { ...tx, merchant: "x" }],
      ["DELETE", `/api/transactions/${added.id}`],
      ["PATCH", `/api/items/${item.id}`, { plannedCents: 1 }],
      ["POST", `/api/months/${month.id}/groups`, { name: "New" }],
      ["POST", "/api/funds", { name: "F" }],
      ["POST", `/api/months/${month.id}/close`, {}],
      ["GET", "/api/settings/budget"],
      ["GET", "/api/export"],
      ["GET", "/api/keys"],
      ["GET", "/api/auth/sessions"],
    ];
    for (const [m, url, body] of denied) expect((await as(m, url, body)).status, `${m} ${url}`).toBe(403);
  });

  it("can be changed later without a new key", async () => {
    const k = await makeKey("read");
    const as = withKey(k.key);
    expect((await as("POST", "/api/transactions", tx)).status).toBe(403);
    expect((await t.api("PATCH", `/api/keys/${k.id}`, { access: "add" })).body).toMatchObject({ access: "add" });
    expect((await as("POST", "/api/transactions", tx)).status).toBe(201);
    expect((await as("GET", "/api/months")).status).toBe(403);
    // A key can't change its own access
    expect((await as("PATCH", `/api/keys/${k.id}`, { access: "read_add" })).status).toBe(403);
    expect((await t.api("PATCH", "/api/keys/999", { access: "add" })).status).toBe(404);
  });
});
