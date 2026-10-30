import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ONLY_FIRST_TWO, setupTestApp, type TestApp } from "./helpers.js";
import { runNotifications } from "../src/lib/notifications.js";
import { logEvent } from "../src/lib/appLog.js";

// The sample notification is about the current month
const thisMonth = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
  await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
});

const logs = async (q = "") => (await t.api("GET", `/api/logs${q}`)).body as any[];

describe("logs", () => {
  it("emails: each one sent or failed, with its type and subject (never the message)", async () => {
    await t.api("POST", "/api/settings/notifications/test");
    await t.api("POST", "/api/months/2026/9", { mode: "blank" });
    await t.api("PUT", "/api/settings/notifications", { enabled: true, nudge: false, ...ONLY_FIRST_TWO });
    await runNotifications(t.db, t.app.mail, new Date(2026, 8, 26, 9));
    t.failNext.value = "535 Authentication failed";
    await t.api("POST", "/api/settings/notifications/test");
    expect((await logs("?category=email")).map((r) => [r.level, r.source, r.event])).toEqual([
      ["error", "Notification test", `Couldn't send "[Test] Time to wrap up ${thisMonth}" to cory@example.com`],
      ["info", "Wrap-Up reminder", 'Sent "Time to wrap up September 2026" to cory@example.com'],
      ["info", "Notification test", `Sent "[Test] Time to wrap up ${thisMonth}" to cory@example.com`],
    ]);
    expect((await logs("?category=email"))[0].detail).toMatch(/535 Authentication failed/);
    expect(JSON.stringify(await logs())).not.toMatch(/almost over|This is a test/);
  });

  it("API: refused API key requests and unknown keys", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n", access: "add" })).body.key;
    const token = t.getToken();
    t.setToken("");
    await t.api("GET", "/api/months", undefined, { "x-api-key": key });
    await t.api("GET", "/api/months", undefined, { "x-api-key": "cd_notarealkey" });
    t.setToken(token);
    expect((await logs("?category=api")).map((r) => [r.level, r.source, r.event])).toEqual([
      ["warning", expect.any(String), "Refused GET /api/months: unknown API key"],
      ["warning", 'API key "n8n"', "Refused GET /api/months: not allowed for this key"],
    ]);
  });

  it("filters by type and problems; All is everything, newest first", async () => {
    await logEvent(t.db, { category: "schedule", level: "info", source: "Daily backup", event: "Backup saved" });
    await logEvent(t.db, { category: "ai", level: "warning", source: "Home AI", event: "Home AI didn't answer, asking Cloud instead", detail: "timed out" });
    await logEvent(t.db, { category: "bank", level: "error", source: "Stanford FCU", event: "Couldn't sync Stanford FCU" });
    expect((await logs()).map((r) => r.category)).toEqual(["bank", "ai", "schedule"]);
    expect((await logs("?category=ai")).map((r) => r.source)).toEqual(["Home AI"]);
    expect((await logs("?problems=true")).map((r) => r.category)).toEqual(["bank", "ai"]);
    expect((await t.api("GET", "/api/logs?category=nope")).status).toBe(400);
  });

  it("keeps 30 days, and only a signed-in user can read them", async () => {
    await t.db.execute(sql`insert into app_log (category, level, event, at) values
      ('schedule', 'info', 'old', ${new Date(Date.now() - 31 * 24 * 3600 * 1000)}), ('schedule', 'info', 'recent', ${new Date(Date.now() - 29 * 24 * 3600 * 1000)})`);
    expect((await logs()).map((r) => r.event)).toEqual(["recent"]);
    const key = (await t.api("POST", "/api/keys", { name: "x", access: "read" })).body.key;
    t.setToken("");
    expect((await t.api("GET", "/api/logs", undefined, { "x-api-key": key })).status).toBe(403);
  });
});
