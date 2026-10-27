import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => t.reset());
afterAll(async () => t.close());

describe("login", () => {
  it("health is public, everything else needs login", async () => {
    expect((await t.api("GET", "/api/health")).status).toBe(200);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
  });

  it("first run requires setup, then setup is locked", async () => {
    expect((await t.api("GET", "/api/auth/status")).body).toEqual({ setupRequired: true });
    const setup = await t.api("POST", "/api/auth/setup", { username: "cory", password: "password123" });
    expect(setup.status).toBe(200);
    expect(setup.body.token).toBeTruthy();
    expect((await t.api("GET", "/api/auth/status")).body).toEqual({ setupRequired: false });
    const again = await t.api("POST", "/api/auth/setup", { username: "other", password: "password123" });
    expect(again.status).toBe(409);
  });

  it("rejects short passwords", async () => {
    const res = await t.api("POST", "/api/auth/setup", { username: "cory", password: "short" });
    expect(res.status).toBe(400);
  });

  it("logs in with the right password only", async () => {
    await t.login();
    t.setToken("");
    expect((await t.api("POST", "/api/auth/login", { username: "cory", password: "wrong-pass" })).status).toBe(401);
    const ok = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
    expect(ok.status).toBe(200);
    t.setToken(ok.body.token);
    expect((await t.api("GET", "/api/auth/me")).body.user.username).toBe("cory");
  });

  it("rejects a bad token", async () => {
    await t.login();
    t.setToken("not-a-real-token");
    expect((await t.api("GET", "/api/months")).status).toBe(401);
  });

  it("locks out after 5 failed logins", async () => {
    await t.login();
    t.setToken("");
    for (let i = 0; i < 5; i++) {
      await t.api("POST", "/api/auth/login", { username: "cory", password: "wrong-pass" });
    }
    const res = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
    expect(res.status).toBe(429);
  });

  it("changes the password", async () => {
    await t.login();
    const res = await t.api("POST", "/api/auth/password", { currentPassword: "password123", newPassword: "newpassword456" });
    expect(res.status).toBe(200);
    t.setToken("");
    expect((await t.api("POST", "/api/auth/login", { username: "cory", password: "newpassword456" })).status).toBe(200);
  });
});

describe("API keys", () => {
  it("creates a key that works, shows it once, and can be revoked", async () => {
    await t.login();
    const created = await t.api("POST", "/api/keys", { name: "n8n" });
    expect(created.status).toBe(201);
    const key: string = created.body.key;
    expect(key.startsWith("cd_")).toBe(true);

    const list = await t.api("GET", "/api/keys");
    expect(list.body[0].name).toBe("n8n");
    expect(list.body[0].key).toBeUndefined();

    t.setToken("");
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": key })).status).toBe(200);
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": "cd_wrong" })).status).toBe(401);
    // An API key can't manage keys
    expect((await t.api("POST", "/api/keys", { name: "x" }, { "x-api-key": key })).status).toBe(403);

    await t.login().catch(() => {});
    const login = await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" });
    t.setToken(login.body.token);
    expect((await t.api("DELETE", `/api/keys/${created.body.id}`)).status).toBe(204);
    t.setToken("");
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": key })).status).toBe(401);
  });
});
