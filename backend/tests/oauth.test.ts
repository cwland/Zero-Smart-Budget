import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { fakeIdp } from "./fakeIdp.js";
import { emergencyResetAuth } from "../src/lib/oauth.js";

let t: TestApp;
let idp: Awaited<ReturnType<typeof fakeIdp>>;
beforeAll(async () => {
  idp = await fakeIdp();
  t = await setupTestApp({ oauthFetch: idp.fetchImpl });
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login(); // sam, sam@example.com
  idp.state.down = false;
});

const ORIGIN = "https://budget.example.com";
const settings = (over: object = {}) => ({ enabled: true, providerName: "Authentik", clientId: "zsb-client", clientSecret: "zsb-secret", discoveryUrl: idp.issuer, scopes: "openid email profile", authMode: "PASSWORDS_AND_OAUTH", ...over });
const req = (method: string, url: string, payload?: object, token: string | null = t.getToken()) =>
  t.app.inject({ method: method as "POST", url, payload, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

// Click the button, approve at the provider, come back: returns where the app sends the browser
async function oauth(who: { sub: string; email?: string; verified?: boolean }, path = "/api/auth/oauth/start", token: string | null = null) {
  const start = await req("POST", path, {}, token);
  expect(start.statusCode, start.body).toBe(200);
  const back = idp.approve(start.json().url, who);
  const cb = await t.app.inject({ method: "GET", url: back.pathname + back.search });
  expect(cb.statusCode).toBe(302);
  const to = new URL(cb.headers.location as string);
  return { to, params: new URLSearchParams(to.hash.split("?")[1] ?? "") };
}

describe("OAuth sign-in", () => {
  it("settings: saved with the secret encrypted (never sent back), and tested", async () => {
    const r = await t.api("PUT", "/api/settings/oauth", settings());
    expect(r.body.settings).toMatchObject({ enabled: true, providerName: "Authentik", clientSecretSet: true, ready: true });
    expect(JSON.stringify(r.body)).not.toContain("zsb-secret");
    expect((await t.api("POST", "/api/settings/oauth/test")).body).toMatchObject({ ok: true, issuer: idp.issuer });
    expect((await t.api("GET", "/api/auth/status")).body).toMatchObject({ oauth: { label: "Authentik" }, passwords: true });
  });

  it("signs in with the same verified email (and links it); the page swaps a one-time ticket for the session", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    const { to, params } = await oauth({ sub: "ak-123", email: "Sam@Example.com", verified: true });
    expect(to.origin + to.hash.split("?")[0]).toBe(`${ORIGIN}#/oauth`);
    expect(to.href).not.toContain("eyJ"); // no token in the address bar
    const fin = (await req("POST", "/api/auth/oauth/finish", { ticket: params.get("ticket") }, null)).json();
    expect(fin.user.username).toBe("sam");
    expect((await req("GET", "/api/months", undefined, fin.token)).statusCode).toBe(200);
    expect((await req("POST", "/api/auth/oauth/finish", { ticket: params.get("ticket") }, null)).statusCode).toBe(400); // used up
    expect((await t.api("GET", "/api/settings/oauth")).body.linked).toMatchObject({ issuer: idp.issuer, email: "Sam@Example.com" });
    expect((await t.api("GET", "/api/auth/logins")).body[0]).toMatchObject({ success: true, reason: "Signed in with Authentik" });
    // next time it's found by its ID, whatever the email says
    expect((await oauth({ sub: "ak-123", email: "changed@else.com", verified: true })).params.get("ticket")).toBeTruthy();
  });

  it("refuses an identity that isn't linked (and an unverified email)", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    let r = await oauth({ sub: "stranger", email: "someone@else.com", verified: true });
    expect(r.params.get("oauth_error")).toMatch(/isn't linked/);
    r = await oauth({ sub: "sneaky", email: "sam@example.com", verified: false });
    expect(r.params.get("oauth_error")).toMatch(/isn't linked/);
    const reasons = (await t.api("GET", "/api/auth/logins")).body.map((e: any) => e.reason);
    expect(reasons.filter((x: string) => x.startsWith("OAuth: no matching account"))).toHaveLength(2);
  });

  it("Link my account (signed in) links any identity from the provider", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    const { params, to } = await oauth({ sub: "ak-999", email: "work@company.com" }, "/api/auth/oauth/link/start", t.getToken());
    expect(to.hash).toMatch(/^#\/settings\/security\?/);
    expect(params.get("oauth")).toBe("linked");
    expect((await oauth({ sub: "ak-999" })).params.get("ticket")).toBeTruthy();
  });

  it("OAuth only: needs a linked account first; then the API refuses passwords (passkeys and OAuth still work)", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    expect((await t.api("PUT", "/api/settings/oauth", settings({ authMode: "OAUTH_ONLY" }))).body.error).toMatch(/Link your account first/);
    await oauth({ sub: "ak-1" }, "/api/auth/oauth/link/start", t.getToken());
    expect((await t.api("PUT", "/api/settings/oauth", settings({ authMode: "OAUTH_ONLY" }))).status).toBe(200);
    expect((await t.api("GET", "/api/auth/status")).body).toMatchObject({ passwords: false, resetAvailable: false, oauth: { label: "Authentik" } });
    const pw = await req("POST", "/api/auth/login", { username: "sam", password: "password123" }, null);
    expect(pw.statusCode).toBe(403);
    expect(pw.json().error).toMatch(/Password sign-in is turned off/);
    expect((await req("POST", "/api/auth/forgot", {}, null)).statusCode).toBe(403);
    expect((await req("POST", "/api/auth/passkey/login/options", {}, null)).statusCode).toBe(200); // passkeys stay
    expect((await oauth({ sub: "ak-1" })).params.get("ticket")).toBeTruthy();
    expect((await t.api("POST", "/api/auth/oauth/unlink")).body.error).toMatch(/Switch to Passwords & OAuth/);
  });

  it("emergency reset turns passwords back on", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    await oauth({ sub: "ak-1" }, "/api/auth/oauth/link/start", t.getToken());
    await t.api("PUT", "/api/settings/oauth", settings({ authMode: "OAUTH_ONLY" }));
    expect((await req("POST", "/api/auth/login", { username: "sam", password: "password123" }, null)).statusCode).toBe(403);
    const r = await emergencyResetAuth(t.db);
    expect(r).toEqual({ was: { authMode: "OAUTH_ONLY", enabled: true }, now: { authMode: "PASSWORDS_AND_OAUTH", enabled: false } });
    expect((await req("POST", "/api/auth/login", { username: "sam", password: "password123" }, null)).statusCode).toBe(200);
    expect((await t.api("GET", "/api/auth/status")).body).toMatchObject({ passwords: true, oauth: null });
  });

  it("provider down, a forged state, a declined sign-in, and the wrong client secret all fail safely", async () => {
    await t.api("PUT", "/api/settings/oauth", settings());
    // forged / unknown state
    const forged = await t.app.inject({ method: "GET", url: "/api/auth/oauth/callback?code=x&state=nope" });
    const err = (loc: unknown) => new URLSearchParams(String(loc).split("?")[1]).get("oauth_error");
    expect(err(forged.headers.location)).toMatch(/took too long or was already used/);
    // the user said no at the provider
    const start = (await req("POST", "/api/auth/oauth/start", {}, null)).json();
    const st = new URL(start.url).searchParams.get("state");
    const no = await t.app.inject({ method: "GET", url: `/api/auth/oauth/callback?error=access_denied&state=${st}` });
    expect(err(no.headers.location)).toBe("access_denied");
    // wrong secret: the provider turns the code down
    await t.api("PUT", "/api/settings/oauth", settings({ clientSecret: "wrong" }));
    const bad = await oauth({ sub: "ak-1", email: "sam@example.com", verified: true });
    expect(bad.params.get("oauth_error")).toMatch(/didn't work/);
    // down
    await t.api("PUT", "/api/settings/oauth", settings());
    idp.state.down = true;
    const down = await req("POST", "/api/auth/oauth/start", {}, null);
    expect(down.statusCode).toBe(502);
    expect((await t.api("GET", "/api/logs?category=api")).body[0].event).toMatch(/Couldn't reach Authentik/);
  });

  it("only a signed-in user (not an API key) can see or change the settings", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "x", access: "read" })).body.key;
    t.setToken("");
    expect((await t.api("GET", "/api/settings/oauth", undefined, { "x-api-key": key })).status).toBe(403);
  });
});
