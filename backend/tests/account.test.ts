import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

const linkToken = (text: string) => /#\/reset\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];

describe("profile", () => {
  it("updates username, display name and email", async () => {
    const res = await t.api("PATCH", "/api/profile", { username: "cory2", displayName: "Cory L", email: "cory@example.com" });
    expect(res.body).toMatchObject({ username: "cory2", displayName: "Cory L", email: "cory@example.com" });
    expect((await t.api("GET", "/api/auth/me")).body.user).toMatchObject({ username: "cory2", email: "cory@example.com" });
    // empty clears the display name; the email can't be removed
    expect((await t.api("PATCH", "/api/profile", { displayName: "" })).body).toMatchObject({ email: "cory@example.com", displayName: null });
    for (const email of ["", null, "  "]) expect((await t.api("PATCH", "/api/profile", { email })).body.details[0].message).toMatch(/email address is required/);
  });

  it("saves the theme with the account", async () => {
    expect((await t.api("GET", "/api/auth/me")).body.user.theme).toBeNull();
    expect((await t.api("PATCH", "/api/profile", { theme: "plum-amber" })).body.theme).toBe("plum-amber");
    expect((await t.api("GET", "/api/auth/me")).body.user.theme).toBe("plum-amber");
    expect((await t.api("PATCH", "/api/profile", { theme: "everydollar" })).status).toBe(400);
  });

  it("validates email, and API keys can't change it", async () => {
    expect((await t.api("PATCH", "/api/profile", { email: "nope" })).status).toBe(400);
    const key = (await t.api("POST", "/api/keys", { name: "x" })).body.key;
    t.setToken("");
    expect((await t.api("PATCH", "/api/profile", { displayName: "x" }, { "x-api-key": key })).status).toBe(403);
  });
});

describe("sessions", () => {
  it("sign out everywhere invalidates all tokens; keepThisDevice returns a fresh one", async () => {
    const first = t.getToken();
    const second = (await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" })).body.token;

    const res = await t.api("POST", "/api/auth/logout-all", { keepThisDevice: true });
    expect(res.body.token).toBeTruthy();
    t.setToken(first);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
    t.setToken(second);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
    t.setToken(res.body.token);
    expect((await t.api("GET", "/api/months")).status).toBe(200);

    const all = await t.api("POST", "/api/auth/logout-all", {});
    expect(all.body.token).toBeUndefined();
    expect((await t.api("GET", "/api/months")).status).toBe(401);
  });

  it("changing the password signs out other devices but keeps this one", async () => {
    const other = (await t.api("POST", "/api/auth/login", { username: "cory", password: "password123" })).body.token;
    const res = await t.api("POST", "/api/auth/password", { currentPassword: "password123", newPassword: "newpassword456" });
    expect(res.body.token).toBeTruthy();
    t.setToken(other);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
    t.setToken(res.body.token);
    expect((await t.api("GET", "/api/months")).status).toBe(200);
  });

  it("API keys keep working after sign out everywhere", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    await t.api("POST", "/api/auth/logout-all", {});
    t.setToken("");
    expect((await t.api("GET", "/api/months", undefined, { "x-api-key": key })).status).toBe(200);
  });
});

describe("password reset by email", () => {
  it("status says reset is available only once there's an email on the account", async () => {
    await t.db.execute(sql`update users set email = null`); // (accounts made before email was required)
    expect((await t.api("GET", "/api/auth/status")).body).toMatchObject({ emailEnabled: true, resetAvailable: false });
    await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
    expect((await t.api("GET", "/api/auth/status")).body.resetAvailable).toBe(true);
  });

  it("full flow: request, email arrives, link resets password and signs out everywhere", async () => {
    await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
    const oldToken = t.getToken();
    t.setToken("");
    expect((await t.api("POST", "/api/auth/forgot", {})).status).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].to).toBe("cory@example.com");
    expect(t.sent[0].text).toContain("http://budget.test/#/reset?token=");
    const token = linkToken(t.sent[0].text)!;

    expect((await t.api("POST", "/api/auth/reset", { token, newPassword: "short" })).status).toBe(400);
    const res = await t.api("POST", "/api/auth/reset", { token, newPassword: "brandnew789" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    // Link only works once
    expect((await t.api("POST", "/api/auth/reset", { token, newPassword: "another12345" })).status).toBe(400);
    // Old sessions are out, new password works
    t.setToken(oldToken);
    expect((await t.api("GET", "/api/months")).status).toBe(401);
    expect((await t.api("POST", "/api/auth/login", { username: "cory", password: "brandnew789" })).status).toBe(200);
  });

  it("only the newest link works, and expired links fail", async () => {
    await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
    t.setToken("");
    await t.api("POST", "/api/auth/forgot", {});
    const firstToken = linkToken(t.sent[0].text)!;
    // second request within a minute is rate-limited
    expect((await t.api("POST", "/api/auth/forgot", {})).status).toBe(429);

    // Simulate time passing for the rate limit by making a new link directly through the API after reset of limits
    const { resetLoginLockouts } = await import("../src/routes/auth.js");
    resetLoginLockouts();
    await t.api("POST", "/api/auth/forgot", {});
    expect((await t.api("POST", "/api/auth/reset", { token: firstToken, newPassword: "brandnew789" })).status).toBe(400);

    // Expire the newest link
    const { sql } = await import("drizzle-orm");
    await t.db.execute(sql`update password_resets set expires_at = now() - interval '1 minute'`);
    const second = linkToken(t.sent[1].text)!;
    expect((await t.api("POST", "/api/auth/reset", { token: second, newPassword: "brandnew789" })).status).toBe(400);
  });

  it("doesn't send anything (but answers the same) when there's no email on file", async () => {
    await t.db.execute(sql`update users set email = null`);
    t.setToken("");
    const res = await t.api("POST", "/api/auth/forgot", {});
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(0);
  });

  it("test email goes to the account address", async () => {
    await t.db.execute(sql`update users set email = null`);
    expect((await t.api("POST", "/api/settings/email/test", {})).status).toBe(400); // no address yet
    await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
    const res = await t.api("POST", "/api/settings/email/test", {});
    expect(res.body).toMatchObject({ ok: true, to: "cory@example.com" });
    expect(t.sent[0].subject).toBe("[Test] Zero Smart Budget email is working");
    expect(t.sent[0].html).toContain("Test email.");
    expect(t.sent[0].attachments?.[0]).toMatchObject({ cid: "zsb-logo", contentType: "image/png" });
  });
});

describe("without email", () => {
  it("forgot is refused and status says so", async () => {
    const noMail = await setupTestApp({ email: false });
    try {
      await noMail.reset();
      await noMail.login();
      await noMail.api("PATCH", "/api/profile", { email: "cory@example.com" });
      expect((await noMail.api("GET", "/api/auth/status")).body).toMatchObject({ emailEnabled: false, resetAvailable: false });
      noMail.setToken("");
      const res = await noMail.api("POST", "/api/auth/forgot", {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reset-password");
    } finally {
      await noMail.close();
    }
  });
});

describe("what's new", () => {
  it("remembers which version's notes were dismissed", async () => {
    expect((await t.api("GET", "/api/auth/me")).body.user.seenVersion).toBeNull();
    expect((await t.api("PUT", "/api/auth/seen-version", { version: "0.2.0" })).body).toEqual({ seenVersion: "0.2.0" });
    expect((await t.api("GET", "/api/auth/me")).body.user.seenVersion).toBe("0.2.0");
    expect((await t.api("PUT", "/api/auth/seen-version", { version: "latest" })).status).toBe(400);
  });
});
