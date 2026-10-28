import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
  await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
});
afterAll(async () => t.close());

const gmail = {
  enabled: true,
  host: "smtp.gmail.com",
  port: 587,
  security: "starttls",
  username: "cory@gmail.com",
  password: "app-password-123",
  fromName: "Cory's Dollar",
  fromAddress: "cory@gmail.com",
  appUrl: "https://budget.example.com/",
};

describe("email settings saved in the app", () => {
  it("starts from .env when nothing is saved", async () => {
    const res = (await t.api("GET", "/api/settings/email")).body;
    expect(res).toMatchObject({ source: "env", active: true, settings: null, env: { available: true, host: "env.smtp:25" } });
  });

  it("saves settings; the password is encrypted and never returned", async () => {
    expect((await t.api("PUT", "/api/settings/email", gmail)).status).toBe(200);
    const res = (await t.api("GET", "/api/settings/email")).body;
    expect(res.source).toBe("app");
    expect(res.settings).toMatchObject({ host: "smtp.gmail.com", security: "starttls", username: "cory@gmail.com", passwordSet: true, appUrl: "https://budget.example.com" });
    expect(JSON.stringify(res)).not.toContain("app-password-123");

    const row = await t.db.execute(sql`select value::text as v from app_settings where key = 'email'`);
    const stored = String((row.rows[0] as { v: string }).v);
    expect(stored).not.toContain("app-password-123");
    expect(stored).toContain("v1:");
  });

  it("app settings win over .env, including for reset links", async () => {
    await t.api("PUT", "/api/settings/email", gmail);
    t.setToken("");
    await t.api("POST", "/api/auth/forgot", {});
    expect(t.sent[0].config).toMatchObject({ host: "smtp.gmail.com", username: "cory@gmail.com", password: "app-password-123" });
    expect(t.sent[0].from).toBe('"Cory\'s Dollar" <cory@gmail.com>');
    expect(t.sent[0].text).toContain("https://budget.example.com/#/reset?token=");
  });

  it("blank password keeps the saved one; empty string removes it", async () => {
    await t.api("PUT", "/api/settings/email", gmail);
    const { password: _p, ...noPassword } = gmail;
    await t.api("PUT", "/api/settings/email", { ...noPassword, fromName: "Budget" });
    await t.api("POST", "/api/settings/email/test", {});
    expect(t.sent[0].config.password).toBe("app-password-123");
    expect(t.sent[0].from).toContain('"Budget"');

    await t.api("PUT", "/api/settings/email", { ...gmail, password: "" });
    expect((await t.api("GET", "/api/settings/email")).body.settings.passwordSet).toBe(false);
  });

  it("turning email off in the app disables it (doesn't fall back to .env)", async () => {
    await t.api("PUT", "/api/settings/email", { ...gmail, enabled: false });
    expect((await t.api("GET", "/api/auth/status")).body).toMatchObject({ emailEnabled: false, resetAvailable: false });
    // Clearing the app settings brings .env back
    expect((await t.api("DELETE", "/api/settings/email")).status).toBe(204);
    expect((await t.api("GET", "/api/auth/status")).body.emailEnabled).toBe(true);
  });

  it("validates when enabled", async () => {
    const bad = await t.api("PUT", "/api/settings/email", { ...gmail, host: "", fromAddress: "nope", appUrl: "budget.local" });
    expect(bad.status).toBe(400);
    const paths = bad.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["host", "fromAddress", "appUrl"]));
    // Disabled settings can be saved incomplete
    expect((await t.api("PUT", "/api/settings/email", { enabled: false })).status).toBe(200);
  });

  it("test sends with unsaved form values, using the saved password if the field is blank", async () => {
    await t.api("PUT", "/api/settings/email", gmail);
    const { password: _p, ...form } = gmail;
    const res = await t.api("POST", "/api/settings/email/test", { settings: { ...form, host: "smtp.other.com" }, to: "someone@else.com" });
    expect(res.body).toMatchObject({ ok: true, to: "someone@else.com" });
    expect(t.sent[0].config).toMatchObject({ host: "smtp.other.com", password: "app-password-123" });
    // Nothing was saved by testing
    expect((await t.api("GET", "/api/settings/email")).body.settings.host).toBe("smtp.gmail.com");
  });

  it("reports send failures clearly", async () => {
    await t.api("PUT", "/api/settings/email", gmail);
    t.failNext.value = "Invalid login: 535 Username and Password not accepted";
    const res = await t.api("POST", "/api/settings/email/test", {});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Username and Password not accepted");
  });

  it("a changed JWT secret makes the saved password unreadable (and says so)", async () => {
    await t.api("PUT", "/api/settings/email", gmail);
    await t.db.execute(sql`update app_settings set value = jsonb_set(value, '{passwordEnc}', '"v1:AAAA:BBBB:CCCC"')`);
    const res = (await t.api("GET", "/api/settings/email")).body;
    expect(res.settings).toMatchObject({ passwordSet: true, passwordUnreadable: true });
  });

  it("only a logged-in user can see or change email settings", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "x" })).body.key;
    t.setToken("");
    expect((await t.api("GET", "/api/settings/email", undefined, { "x-api-key": key })).status).toBe(403);
    expect((await t.api("PUT", "/api/settings/email", gmail, { "x-api-key": key })).status).toBe(403);
  });
});
