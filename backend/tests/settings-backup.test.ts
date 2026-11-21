import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { exportSettings, importSettings } from "../src/lib/settingsBackup.js";

const KEY = "my-backup-key-0123456789";
let t: TestApp; // has BACKUP_KEY
let plain: TestApp; // no BACKUP_KEY
beforeAll(async () => {
  t = await setupTestApp({ backupKey: KEY });
  plain = await setupTestApp();
});
afterAll(async () => {
  await t.close();
  await plain.close();
});
beforeEach(async () => {
  await t.reset();
  await t.login();
});

const gmail = { enabled: true, host: "smtp.gmail.com", port: 587, security: "starttls", username: "sam@example.com", password: "app-password-123", fromName: "Zero Smart Budget", fromAddress: "sam@example.com", appUrl: "https://budget.example.com" };
const ai = { maxPerRun: 50, services: [{ name: "Cloud", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-secret-123" }, { name: "Home AI", provider: "local", model: "qwen", baseUrl: "http://10.0.0.5:11434/v1", apiKey: "" }] };
const setUp = async () => {
  await t.api("PUT", "/api/settings/email", gmail);
  await t.api("PUT", "/api/settings/ai", ai);
  await t.api("PUT", "/api/settings/ai/usage", { enabled: true, mode: "manual" });
  await t.api("PUT", "/api/settings/budget", { quickAssign: false });
};

describe("settings in backups", () => {
  it("with BACKUP_KEY: settings are in, keys and passwords encrypted with it (never in plain text)", async () => {
    await setUp();
    expect((await t.api("GET", "/api/backups")).body).toMatchObject({ secretsIncluded: true, backupKeyProblem: null });
    const file = (await t.api("GET", "/api/export")).body;
    expect(file.exportVersion).toBe(4);
    expect(file.settings.secrets).toBe("encrypted");
    expect(file.settings.values.budget).toMatchObject({ quickAssign: false });
    expect(file.settings.values.ai.services[0].apiKeyEnc).toMatch(/^v1:/);
    expect(file.settings.values.ai.services[1].apiKeyEnc).toBeNull(); // never had one
    const text = JSON.stringify(file);
    expect(text).not.toContain("sk-secret-123");
    expect(text).not.toContain("app-password-123");
  });

  it("restores settings and their keys", async () => {
    await setUp();
    const file = (await t.api("GET", "/api/export")).body;
    await t.api("DELETE", "/api/settings/ai");
    await t.api("DELETE", "/api/settings/email");
    await t.api("PUT", "/api/settings/budget", { quickAssign: true });
    const r = (await t.api("POST", "/api/import?confirm=replace", file)).body;
    expect(r.settings).toMatchObject({ settingsRestored: 3, secretsRestored: 2, secretsMissing: 0 });
    const s = (await t.api("GET", "/api/settings/ai")).body.settings;
    expect(s).toMatchObject({ enabled: true, mode: "manual" });
    expect(s.services.map((x: any) => x.apiKey)).toEqual(["sk-secret-123", null]);
    expect((await t.api("GET", "/api/settings/email/password")).body.password).toBe("app-password-123");
    expect((await t.api("GET", "/api/settings/budget")).body).toMatchObject({ quickAssign: false });
  });

  it("moves to a server with a different JWT_SECRET when BACKUP_KEY matches; a wrong key brings nothing back", async () => {
    await setUp();
    const section = await exportSettings(t.db, { jwtSecret: "test-secret-that-is-long-enough", backupKey: KEY });
    await t.reset();
    // A new server: different JWT secret, same backup key
    expect(await importSettings(t.db, section, { jwtSecret: "another-server-secret-123", backupKey: KEY })).toMatchObject({ secretsRestored: 2, secretsMissing: 0 });
    const there = await exportSettings(t.db, { jwtSecret: "another-server-secret-123", backupKey: KEY });
    expect((there.values.ai as any).services[0].apiKeyEnc).toMatch(/^v1:/); // readable on the new server
    // Wrong backup key
    await t.reset();
    expect(await importSettings(t.db, section, { jwtSecret: "another-server-secret-123", backupKey: "a-different-key-0000000" })).toMatchObject({ secretsRestored: 0, secretsMissing: 2 });
  });

  it("without BACKUP_KEY: settings are backed up but keys are left out; restoring keeps the keys you have", async () => {
    await plain.reset();
    await plain.login();
    expect((await plain.api("GET", "/api/backups")).body).toMatchObject({ secretsIncluded: false });
    await plain.api("PUT", "/api/settings/email", gmail);
    await plain.api("PUT", "/api/settings/ai", ai);
    const file = (await plain.api("GET", "/api/export")).body;
    expect(file.settings.secrets).toBe("left out");
    expect(file.settings.values.email.passwordEnc).toMatch(/^left-out/);
    expect(JSON.stringify(file)).not.toContain("app-password-123");
    // Restoring here: the saved keys stay
    let r = (await plain.api("POST", "/api/import?confirm=replace", file)).body;
    expect(r.settings).toMatchObject({ secretsRestored: 0, secretsKept: 2, secretsMissing: 0 });
    expect((await plain.api("GET", "/api/settings/email/password")).body.password).toBe("app-password-123");
    // ...on a fresh setup they need entering again
    await plain.api("DELETE", "/api/settings/email");
    await plain.api("DELETE", "/api/settings/ai");
    r = (await plain.api("POST", "/api/import?confirm=replace", file)).body;
    expect(r.settings).toMatchObject({ secretsMissing: 2 });
    expect((await plain.api("GET", "/api/settings/email")).body.settings).toMatchObject({ host: "smtp.gmail.com", passwordSet: false });
  });

  it("a backup from another server restores with that server's key, given for this restore only", async () => {
    // Made on a server with a different BACKUP_KEY
    const other = await setupTestApp({ backupKey: "the-other-servers-key-123", jwtSecret: "another-server-secret-123" });
    await other.reset();
    await other.login();
    await other.api("PUT", "/api/settings/ai", ai);
    const file = (await other.api("GET", "/api/export")).body;
    await other.close();
    // (both servers share the test database: sign in again here)
    t.setToken((await t.api("POST", "/api/auth/login", { username: "sam", password: "password123" })).body.token);

    const restore = (key?: string) => t.app.inject({ method: "POST", url: "/api/import?confirm=replace", payload: file, headers: { authorization: `Bearer ${t.getToken()}`, ...(key ? { "x-backup-key": key } : {}) } }).then((r) => ({ status: r.statusCode, body: r.json() }));
    // Wrong key: refused before anything changes
    await t.api("PUT", "/api/settings/budget", { quickAssign: false });
    const wrong = await restore("not-the-right-key-000");
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/doesn't match this file/);
    expect((await t.api("GET", "/api/settings/budget")).body.quickAssign).toBe(false);
    // Right key: keys come back
    const ok = await restore("the-other-servers-key-123");
    expect(ok.body.settings).toMatchObject({ secretsRestored: 1, secretsMissing: 0 });
    expect((await t.api("GET", "/api/settings/ai")).body.settings.services[0].apiKey).toBe("sk-secret-123");
    // Without it (this server's own key doesn't match): settings come back, keys don't
    await t.api("DELETE", "/api/settings/ai");
    expect((await restore()).body.settings).toMatchObject({ secretsRestored: 0, secretsMissing: 1 });
  });

  it("older backups without settings leave your settings alone", async () => {
    await setUp();
    const file = (await t.api("GET", "/api/export")).body;
    delete file.settings;
    file.exportVersion = 3;
    const r = (await t.api("POST", "/api/import?confirm=replace", file)).body;
    expect(r.settings).toBeNull();
    expect((await t.api("GET", "/api/settings/ai")).body.settings.services[0].apiKey).toBe("sk-secret-123");
  });

  it("a BACKUP_KEY that's too short is reported and not used", async () => {
    const short = await setupTestApp({ backupKey: "short" });
    await short.reset();
    await short.login();
    expect((await short.api("GET", "/api/backups")).body).toMatchObject({ secretsIncluded: false, backupKeyProblem: expect.stringMatching(/too short/) });
    await short.close();
  });
});
