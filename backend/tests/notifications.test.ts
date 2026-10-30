import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ONLY_FIRST_TWO, setupTestApp, type TestApp } from "./helpers.js";
import { resetActiveMark, runNotifications } from "../src/lib/notifications.js";
import { users } from "../src/db/schema.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
  await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
});

const run = (d: Date) => runNotifications(t.db, t.app.mail, d);
const lastActive = (d: Date) => t.db.update(users).set({ lastActiveAt: d }).where(eq(users.id, 1));

describe("notifications", () => {
  it("off until turned on; needs email set up and an address", async () => {
    expect((await t.api("GET", "/api/settings/notifications")).body).toMatchObject({
      settings: { enabled: false, monthCloseReminder: true, nudge: true, nudgeDays: 7, monthlySummary: true, weekly: true, weeklyDay: 0, largePurchaseCents: 50000, nextMonthDays: 3 },
      emailReady: true,
      to: "cory@example.com",
    });
    expect((await run(new Date(2026, 9, 28))).skipped).toBe("notifications are off");
    await t.db.execute(sql`update users set email = null`);
    expect((await t.api("PUT", "/api/settings/notifications", { enabled: true })).body.error).toMatch(/Add your email address/);
    await t.api("PATCH", "/api/profile", { email: "cory@example.com" });
    expect((await t.api("PUT", "/api/settings/notifications", { enabled: true, nudgeDays: 5 })).body.settings).toMatchObject({ enabled: true, nudgeDays: 5 });
    expect((await t.api("PUT", "/api/settings/notifications", { nudgeDays: 0 })).status).toBe(400);
  });

  it("sends a branded sample of each notification, marked [Test]", async () => {
    await t.api("PATCH", "/api/profile", { theme: "slate-rose" });
    const r = (await t.api("POST", "/api/settings/notifications/test", { kind: "month-close" })).body;
    expect(r).toMatchObject({ ok: true, to: "cory@example.com" });
    const sent = t.sent.at(-1)!;
    expect(sent.subject).toMatch(/^\[Test\] Time to wrap up /);
    expect(sent.html).toContain("Test email.</strong> This is a sample of the Wrap-Up reminder");
    expect(sent.html).toContain("#f43f5e"); // the account's theme (Slate & Rose)
    expect(sent.html).toContain('src="cid:zsb-logo"');
    expect(sent.text).toMatch(/^TEST EMAIL: this is a sample of the Wrap-Up reminder/);
    expect(sent.attachments?.[0]).toMatchObject({ cid: "zsb-logo", contentType: "image/png" });

    // Nudge: real waiting transactions are listed
    await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Corner Market", amountCents: 1234, splits: [] });
    await t.api("POST", "/api/settings/notifications/test", { kind: "nudge" });
    expect(t.sent.at(-1)!.subject).toBe("[Test] 1 transaction is waiting for you");
    expect(t.sent.at(-1)!.text).toContain("- Corner Market (Oct 5): $12.34");
  });

  it("previews a notification in the browser without sending", async () => {
    const before = t.sent.length;
    const r = await t.api("GET", "/api/settings/notifications/preview?kind=nudge");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.text).toContain("data:image/png;base64,");
    expect(r.text).not.toContain("cid:");
    expect(t.sent.length).toBe(before);
  });

  it("reminds once when it's time to close a month, and not after it's closed", async () => {
    const sep = (await t.api("POST", "/api/months/2026/9", { mode: "blank" })).body;
    await t.api("PUT", "/api/settings/notifications", { enabled: true, nudge: false, ...ONLY_FIRST_TWO });
    await lastActive(new Date(2026, 8, 25));
    expect((await run(new Date(2026, 8, 20, 9))).sent).toEqual([]); // too early
    const r = await run(new Date(2026, 8, 26, 9)); // 4 days before the 30th
    expect(r.sent).toEqual([{ key: "month-close:2026-09", kind: "month-close", to: "cory@example.com", subject: "Time to wrap up September 2026" }]);
    expect(t.sent.at(-1)!.text).toMatch(/^Time to wrap up September 2026\n\nSeptember 2026 is almost over\. Wrap it up/);
    expect(t.sent.at(-1)!.html).toContain("Wrap up September 2026");
    expect((await run(new Date(2026, 8, 27, 9))).sent).toEqual([]); // only once

    // Closed: no reminder for it next month either
    await t.api("POST", `/api/months/${sep.id}/close`, {});
    expect((await run(new Date(2026, 9, 2, 9))).sent).toEqual([]);
  });

  it("reminds about last month if it's still open, unless Month Close is off", async () => {
    await t.api("POST", "/api/months/2026/9", { mode: "blank" });
    await t.api("PUT", "/api/settings/notifications", { enabled: true, nudge: false, ...ONLY_FIRST_TWO });
    await t.api("PUT", "/api/settings/budget", { monthCloseEnabled: false });
    expect((await run(new Date(2026, 9, 3, 9))).sent).toEqual([]);
    await t.api("PUT", "/api/settings/budget", { monthCloseEnabled: true });
    const r = await run(new Date(2026, 9, 3, 9));
    expect(r.sent.map((s) => s.subject)).toEqual(["Time to wrap up September 2026"]);
    expect(t.sent.at(-1)!.text).toMatch(/\n\nSeptember 2026 is over\./);
  });

  it("nudges after X days away when transactions are waiting, at most every X days", async () => {
    await t.api("PUT", "/api/settings/notifications", { enabled: true, monthCloseReminder: false, nudgeDays: 7, ...ONLY_FIRST_TWO });
    await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "Mystery", amountCents: 500 });
    await lastActive(new Date(2026, 9, 1, 12));

    expect((await run(new Date(2026, 9, 7, 12))).sent).toEqual([]); // 6 days
    let r = await run(new Date(2026, 9, 8, 13)); // 7 days
    expect(r.sent[0]).toMatchObject({ kind: "nudge", subject: "1 transaction is waiting for you" });
    expect(t.sent.at(-1)!.text).toMatch(/It's been 7 days since you last checked your budget/);
    expect((await run(new Date(2026, 9, 10, 13))).sent).toEqual([]); // nudged 2 days ago
    expect((await run(new Date(2026, 9, 15, 14))).sent).toHaveLength(1); // 7 days after the last nudge, still away

    // Came back: the clock starts over
    await lastActive(new Date(2026, 9, 16, 9));
    expect((await run(new Date(2026, 9, 20, 9))).sent).toEqual([]);
    // Nothing waiting: no nudge, however long away
    await t.db.execute(sql`update transactions set deleted_at = now()`);
    expect((await run(new Date(2026, 10, 30, 9))).sent).toEqual([]);
  });

  it("using the app records activity", async () => {
    await t.db.update(users).set({ lastActiveAt: null }).where(eq(users.id, 1));
    resetActiveMark();
    t.clock.date = new Date(2026, 9, 28, 20);
    await t.api("GET", "/api/months");
    const [u] = await t.db.select({ at: users.lastActiveAt }).from(users);
    expect(u.at?.toISOString()).toBe(new Date(2026, 9, 28, 20).toISOString());
  });

  it("a failed send is tried again next time", async () => {
    await t.api("PUT", "/api/settings/notifications", { enabled: true, monthCloseReminder: false, ...ONLY_FIRST_TWO });
    await t.api("POST", "/api/transactions", { date: "2026-10-01", merchant: "Mystery", amountCents: 500 });
    await lastActive(new Date(2026, 9, 1));
    t.failNext.value = "SMTP down";
    await expect(run(new Date(2026, 9, 20))).rejects.toThrow("SMTP down");
    expect((await run(new Date(2026, 9, 20))).sent).toHaveLength(1);
  });
});
