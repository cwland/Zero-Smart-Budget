import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { softPasskey } from "./softPasskey.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
});

const LOCAL = "http://localhost:5173";
const SITE = "https://budget.example.com";
const call = (method: string, url: string, origin: string | null, payload?: object, token = t.getToken()) =>
  t.app
    .inject({ method: method as "POST", url, payload, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" } })
    .then((r) => ({ status: r.statusCode, body: r.body ? r.json() : undefined }));

async function addPasskey(key: ReturnType<typeof softPasskey>, origin = LOCAL, name?: string) {
  const o = await call("POST", "/api/auth/passkeys/register/options", origin);
  expect(o.status).toBe(200);
  return call("POST", "/api/auth/passkeys/register/verify", origin, { challengeId: o.body.challengeId, response: key.create(o.body.options, origin), name });
}
async function signIn(key: ReturnType<typeof softPasskey>, origin = LOCAL, signAs?: string) {
  const o = await call("POST", "/api/auth/passkey/login/options", origin, {}, "");
  expect(o.status).toBe(200);
  return call("POST", "/api/auth/passkey/login/verify", origin, { challengeId: o.body.challengeId, response: key.get(o.body.options, origin, signAs) }, "");
}

describe("passkeys", () => {
  it("add one while signed in, then sign in with it (no password)", async () => {
    const key = softPasskey({ synced: true });
    const added = await addPasskey(key);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: "Passkey on Chrome on Mac", rpId: "localhost" });

    const r = await signIn(key);
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe("cory");
    expect((await call("GET", "/api/months", null, undefined, r.body.token)).status).toBe(200);

    const list = (await call("GET", "/api/auth/passkeys", LOCAL)).body;
    expect(list[0]).toMatchObject({ name: "Passkey on Chrome on Mac", rpId: "localhost", synced: true });
    expect(list[0].lastUsedAt).toBeTruthy();
    // shows as a passkey sign-in in the devices list and history
    expect((await call("GET", "/api/auth/sessions", null)).body.find((s: any) => s.how === "passkey")).toBeTruthy();
    expect((await call("GET", "/api/auth/logins", null)).body[0]).toMatchObject({ success: true, reason: "Signed in with passkey (Passkey on Chrome on Mac)" });
  });

  it("each passkey belongs to the address it was made on", async () => {
    const key = softPasskey();
    expect((await addPasskey(key, SITE, "iPhone")).body.rpId).toBe("budget.example.com");
    expect((await signIn(key, SITE)).status).toBe(200);
    // the same passkey at another address isn't set up there
    const other = await signIn(key, LOCAL, "budget.example.com");
    expect(other.status).toBe(401);
    expect(other.body.error).toMatch(/isn't set up here/);
    expect((await call("GET", "/api/auth/passkeys", LOCAL)).body[0]).toMatchObject({ rpId: "budget.example.com" });
  });

  it("needs https (or localhost), and PASSKEY_ORIGINS can limit the addresses", async () => {
    const r = await call("POST", "/api/auth/passkey/login/options", "http://192.168.1.20:5173", {}, "");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/secure address/);
    expect((await call("POST", "/api/auth/passkey/login/options", null, {}, "")).status).toBe(400); // no browser
    process.env.PASSKEY_ORIGINS = "https://budget.example.com";
    try {
      expect((await call("POST", "/api/auth/passkey/login/options", "https://evil.example.net", {}, "")).body.error).toMatch(/aren't allowed/);
      expect((await call("POST", "/api/auth/passkey/login/options", SITE, {}, "")).status).toBe(200);
    } finally {
      delete process.env.PASSKEY_ORIGINS;
    }
  });

  it("refuses a forged or replayed sign-in, and an unknown passkey", async () => {
    const key = softPasskey();
    await addPasskey(key);
    const o = await call("POST", "/api/auth/passkey/login/options", LOCAL, {}, "");
    const good = key.get(o.body.options, LOCAL);
    const forged = { ...good, response: { ...good.response, signature: softPasskey().get(o.body.options, LOCAL).response.signature } };
    expect((await call("POST", "/api/auth/passkey/login/verify", LOCAL, { challengeId: o.body.challengeId, response: forged }, "")).status).toBe(401);
    // the challenge is used up either way
    expect((await call("POST", "/api/auth/passkey/login/verify", LOCAL, { challengeId: o.body.challengeId, response: good }, "")).body.error).toMatch(/too long/);
    expect((await signIn(softPasskey())).body.error).toMatch(/isn't set up here/);
    const history = (await call("GET", "/api/auth/logins", null)).body.map((e: any) => e.reason);
    expect(history).toContain("Unknown passkey");
    expect(history.some((r: string) => r.startsWith("Passkey check failed"))).toBe(true);
  });

  it("rename and remove; only signed in (not API keys); the same one can't be added twice", async () => {
    const key = softPasskey();
    const { id } = (await addPasskey(key)).body;
    expect((await addPasskey(key)).body.error).toMatch(/already added/); // (a real browser also refuses it up front)
    expect((await call("PATCH", `/api/auth/passkeys/${id}`, LOCAL, { name: "MacBook Touch ID" })).body.name).toBe("MacBook Touch ID");
    const apiKey = (await t.api("POST", "/api/keys", { name: "x", access: "read" })).body.key;
    expect((await t.app.inject({ method: "GET", url: "/api/auth/passkeys", headers: { "x-api-key": apiKey } })).statusCode).toBe(403);
    expect((await call("DELETE", `/api/auth/passkeys/${id}`, LOCAL)).status).toBe(204);
    expect((await signIn(key)).status).toBe(401);
  });
});
