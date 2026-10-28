import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

const keys = { clientId: "client-123", env: "sandbox", sandboxSecret: "sand-secret-abc", productionSecret: "prod-secret-xyz" };

describe("Plaid settings", () => {
  it("starts empty, saves keys encrypted, returns them only to the signed-in Settings page", async () => {
    expect((await t.api("GET", "/api/settings/plaid")).body).toEqual({ settings: null });
    const saved = await t.api("PUT", "/api/settings/plaid", keys);
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({
      clientId: "client-123", env: "sandbox", sandboxSecretSet: true, productionSecretSet: true,
      sandboxSecret: "sand-secret-abc", productionSecret: "prod-secret-xyz", unreadable: false,
    });
    // Encrypted in the database
    const raw = JSON.stringify((await t.db.execute(sql`select value from app_settings where key = 'plaid'`)).rows);
    expect(raw).not.toContain("sand-secret-abc");
    expect(raw).not.toContain("prod-secret-xyz");
    // The signed-in Settings page gets them back (for the eye button)
    expect((await t.api("GET", "/api/settings/plaid")).body.settings.sandboxSecret).toBe("sand-secret-abc");
  });

  it("blank secret keeps the saved one; empty string removes it", async () => {
    await t.api("PUT", "/api/settings/plaid", keys);
    await t.api("PUT", "/api/settings/plaid", { clientId: "client-123", env: "production" });
    expect((await t.api("GET", "/api/settings/plaid")).body.settings).toMatchObject({ env: "production", sandboxSecretSet: true, productionSecretSet: true });
    await t.api("PUT", "/api/settings/plaid", { clientId: "client-123", env: "sandbox", productionSecret: "" });
    expect((await t.api("GET", "/api/settings/plaid")).body.settings).toMatchObject({ sandboxSecretSet: true, productionSecretSet: false });
  });

  it("tests the saved keys against the right Plaid host", async () => {
    await t.api("PUT", "/api/settings/plaid", keys);
    const res = await t.api("POST", "/api/settings/plaid/test");
    expect(res.body).toEqual({ ok: true, message: "Plaid accepted your Sandbox keys." });
    expect(t.plaid.calls[0].url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(t.plaid.calls[0].body).toMatchObject({ client_id: "client-123", secret: "sand-secret-abc", products: ["transactions"], country_codes: ["US"] });

    await t.api("PUT", "/api/settings/plaid", { clientId: "client-123", env: "production" });
    await t.api("POST", "/api/settings/plaid/test");
    expect(t.plaid.calls[1].url).toBe("https://production.plaid.com/link/token/create");
    expect(t.plaid.calls[1].body.secret).toBe("prod-secret-xyz");
  });

  it("tests unsaved values, filling a blank secret from the saved one for that environment", async () => {
    await t.api("PUT", "/api/settings/plaid", keys);
    await t.api("POST", "/api/settings/plaid/test", { clientId: "client-999", env: "production" });
    expect(t.plaid.calls[0]).toMatchObject({ url: "https://production.plaid.com/link/token/create", body: { client_id: "client-999", secret: "prod-secret-xyz" } });
    await t.api("POST", "/api/settings/plaid/test", { clientId: "client-999", env: "sandbox", sandboxSecret: "typed-now" });
    expect(t.plaid.calls[1].body.secret).toBe("typed-now");
  });

  it("explains Plaid errors and network failures", async () => {
    expect((await t.api("POST", "/api/settings/plaid/test")).body.error).toMatch(/isn't set up/);
    await t.api("PUT", "/api/settings/plaid", { ...keys, productionSecret: null });
    expect((await t.api("POST", "/api/settings/plaid/test", { clientId: "c", env: "production" })).body.error).toMatch(/Enter your Production secret/);
    t.plaid.respond = () => ({ status: 400, json: { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid client_id or secret provided" } });
    const bad = await t.api("POST", "/api/settings/plaid/test");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/didn't accept those keys/);
    t.plaid.down = true;
    expect((await t.api("POST", "/api/settings/plaid/test")).status).toBe(502);
  });

  it("validates input, needs a login, and can be removed", async () => {
    expect((await t.api("PUT", "/api/settings/plaid", { clientId: "", env: "sandbox" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/plaid", { clientId: "x", env: "development" })).status).toBe(400);
    await t.api("PUT", "/api/settings/plaid", keys);
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    const token = t.getToken();
    t.setToken("");
    expect((await t.api("GET", "/api/settings/plaid", undefined, { "x-api-key": key })).status).toBe(403);
    t.setToken(token);
    expect((await t.api("DELETE", "/api/settings/plaid")).status).toBe(204);
    expect((await t.api("GET", "/api/settings/plaid")).body).toEqual({ settings: null });
  });
});
