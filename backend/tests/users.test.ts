import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { runNotifications } from "../src/lib/notifications.js";
import { signInAlertSettled } from "../src/lib/sessions.js";

// Shared access: the owner invites admins and users; everyone shares one budget
let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

const tokenFrom = (link: string) => new URL(link.replace("/#/", "/")).searchParams.get("token")!;

// The owner invites someone and they join; returns their login token (the owner stays signed in)
async function join(role: "admin" | "user", username = role === "admin" ? "alex" : "jess") {
  const owner = t.getToken();
  const inv = await t.api("POST", "/api/users/invites", { name: username === "jess" ? "Jess" : "Alex", email: `${username}@example.com`, role });
  expect(inv.status).toBe(200);
  t.setToken("");
  const res = await t.api("POST", "/api/auth/invite/accept", { token: inv.body.token, username, password: "password456" });
  expect(res.status).toBe(200);
  t.setToken(owner);
  return res.body.token as string;
}
async function as<T>(token: string, fn: () => Promise<T>) {
  const owner = t.getToken();
  t.setToken(token);
  try {
    return await fn();
  } finally {
    t.setToken(owner);
  }
}

describe("shared access", () => {
  it("the account that set up the server is the owner", async () => {
    expect((await t.api("GET", "/api/auth/me")).body.user).toMatchObject({ username: "sam", role: "owner", tossAnimation: true });
  });

  it("saving the profile keeps the role (Shared access doesn't disappear after a save)", async () => {
    expect((await t.api("PATCH", "/api/profile", { displayName: "Sam R" })).body).toMatchObject({ displayName: "Sam R", role: "owner", tossAnimation: true });
    expect((await t.api("PATCH", "/api/profile", { theme: "midnight-coral" })).body).toMatchObject({ theme: "midnight-coral", role: "owner" });
  });

  it("invite: emailed (branded, with a link), shown in the list, and the link signs them up once", async () => {
    const inv = await t.api("POST", "/api/users/invites", { name: "Jess", email: "jess@example.com", role: "user" });
    expect(inv.body).toMatchObject({ emailed: true, invite: { name: "Jess", email: "jess@example.com", role: "user", expired: false } });
    expect(inv.body.link).toMatch(/^http:\/\/budget\.test\/#\/invite\?token=/);
    const mail = t.sent.at(-1)!;
    expect(mail.to).toBe("jess@example.com");
    expect(mail.subject).toBe("sam shared their budget with you");
    expect(mail.html).toContain("Set up my sign-in");
    expect(mail.html).toContain(inv.body.link);

    const list = (await t.api("GET", "/api/users")).body;
    expect(list.people.map((p: any) => [p.username, p.role])).toEqual([["sam", "owner"]]);
    expect(list.invites).toHaveLength(1);

    t.setToken("");
    const token = tokenFrom(inv.body.link);
    expect((await t.api("GET", `/api/auth/invite?token=${token}`)).body).toEqual({ name: "Jess", email: "jess@example.com", role: "user", from: "sam" });
    expect((await t.api("POST", "/api/auth/invite/accept", { token, username: "Sam", password: "password456" })).status).toBe(409); // username taken
    const joined = await t.api("POST", "/api/auth/invite/accept", { token, username: "jess", password: "password456" });
    expect(joined.body.user).toMatchObject({ username: "jess", displayName: "Jess", email: "jess@example.com", role: "user" });
    expect((await t.api("POST", "/api/auth/invite/accept", { token, username: "jess2", password: "password456" })).status).toBe(400); // used
    expect((await t.api("GET", `/api/auth/invite?token=${token}`)).status).toBe(404);
    // They can sign in with it
    expect((await t.api("POST", "/api/auth/login", { username: "jess", password: "password456" })).status).toBe(200);
  });

  it("invites: one per address, not for someone who has access, renew makes a new link, cancel, and they expire", async () => {
    expect((await t.api("POST", "/api/users/invites", { email: "sam@example.com", role: "user" })).status).toBe(409);
    expect((await t.api("POST", "/api/users/invites", { email: "nope", role: "user" })).status).toBe(400);
    expect((await t.api("POST", "/api/users/invites", { email: "a@example.com", role: "owner" })).status).toBe(400);
    const first = (await t.api("POST", "/api/users/invites", { email: "a@example.com", role: "user" })).body;
    const second = (await t.api("POST", "/api/users/invites", { email: "A@example.com", role: "admin" })).body;
    expect((await t.api("GET", "/api/users")).body.invites.map((i: any) => i.role)).toEqual(["admin"]);
    expect((await t.api("GET", `/api/auth/invite?token=${first.token}`)).status).toBe(404);

    const renewed = (await t.api("POST", `/api/users/invites/${second.invite.id}/renew`)).body;
    expect(renewed.token).not.toBe(second.token);
    expect((await t.api("GET", `/api/auth/invite?token=${second.token}`)).status).toBe(404);
    expect((await t.api("GET", `/api/auth/invite?token=${renewed.token}`)).status).toBe(200);

    t.clock.date = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect((await t.api("GET", "/api/users")).body.invites[0].expired).toBe(true);
    expect((await t.api("GET", `/api/auth/invite?token=${renewed.token}`)).status).toBe(404);
    t.clock.date = null;

    expect((await t.api("DELETE", `/api/users/invites/${second.invite.id}`)).status).toBe(204);
    expect((await t.api("GET", "/api/users")).body.invites).toEqual([]);
  });

  it("without the app's address in email settings, the invite isn't emailed (the owner copies the link)", async () => {
    const saved = await t.api("PUT", "/api/settings/email", { enabled: true, host: "smtp.test", port: 25, security: "none", fromAddress: "app@example.com", appUrl: null });
    expect(saved.status).toBe(200);
    const inv = (await t.api("POST", "/api/users/invites", { email: "jess@example.com", role: "user" })).body;
    expect(inv).toMatchObject({ emailed: false, link: null });
    expect(inv.token).toBeTruthy();
    expect((await t.api("GET", "/api/users")).body.emailReady).toBe(false);
  });

  it("only the owner manages shared access; an admin can do everything else", async () => {
    const admin = await join("admin");
    await as(admin, async () => {
      expect((await t.api("GET", "/api/users")).status).toBe(403);
      expect((await t.api("POST", "/api/users/invites", { email: "x@example.com", role: "user" })).status).toBe(403);
      expect((await t.api("GET", "/api/auth/me")).body.user.role).toBe("admin");
      expect((await t.api("GET", "/api/settings/email")).status).toBe(200);
      expect((await t.api("GET", "/api/keys")).status).toBe(200);
      expect((await t.api("GET", "/api/logs")).status).toBe(200);
      expect((await t.api("PUT", "/api/settings/budget", { quickAssign: false })).body.quickAssign).toBe(false);
      expect((await t.api("POST", "/api/accounts/manual", { name: "Cash", type: "cash", balanceCents: 1000 })).status).toBeLessThan(300);
    });
  });

  it("a user uses the budget but can't change the setup (the server refuses, not just the page)", async () => {
    const user = await join("user");
    await as(user, async () => {
      // The budget, transactions and reports work like they do for the owner
      const m = await t.api("POST", "/api/months/2026/10", { mode: "blank" });
      expect(m.status).toBeLessThan(300);
      expect((await t.api("POST", `/api/months/${m.body.id}/groups`, { name: "Food" })).status).toBeLessThan(300);
      expect((await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant: "Shop", amountCents: 1200 })).status).toBeLessThan(300);
      expect((await t.api("GET", "/api/reports?from=2026-10&to=2026-10")).status).toBe(200);
      expect((await t.api("GET", "/api/accounts")).status).toBe(200);
      expect((await t.api("GET", "/api/settings/budget")).status).toBe(200);
      expect((await t.api("GET", "/api/settings/features")).status).toBe(200);
      // Their own profile and security
      expect((await t.api("PATCH", "/api/profile", { displayName: "Jessie" })).status).toBe(200);
      expect((await t.api("GET", "/api/auth/sessions")).status).toBe(200);
      // The setup is off limits
      for (const [method, path, body] of [
        ["GET", "/api/users"],
        ["GET", "/api/settings/email"],
        ["PUT", "/api/settings/email", { enabled: false }],
        ["GET", "/api/settings/plaid"],
        ["GET", "/api/settings/ai"],
        ["GET", "/api/settings/oauth"],
        ["PUT", "/api/settings/features", { plaid: false }],
        ["GET", "/api/keys"],
        ["POST", "/api/keys", { name: "x" }],
        ["GET", "/api/logs"],
        ["GET", "/api/backups"],
        ["GET", "/api/export"],
        ["POST", "/api/import", {}],
        ["POST", "/api/accounts/manual", { name: "Cash", type: "cash", balanceCents: 0 }],
        ["DELETE", "/api/accounts/manual/1"],
        ["POST", "/api/plaid/link-token"],
        ["DELETE", "/api/plaid/items/1"],
        ["POST", "/api/updates/check"],
        ["PUT", "/api/settings/budget", { quickAssign: false }],
      ] as [string, string, object?][]) {
        const r = await t.api(method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 403]);
      }
      expect((await t.api("GET", "/api/settings/email")).body.error).toMatch(/Ask the account owner/);
    });
  });

  it("toss animation: each person's own, on by default", async () => {
    const user = await join("user");
    await as(user, async () => {
      expect((await t.api("GET", "/api/settings/budget")).body.tossAnimation).toBe(true);
      expect((await t.api("PUT", "/api/settings/budget", { tossAnimation: false })).body.tossAnimation).toBe(false);
      expect((await t.api("GET", "/api/auth/me")).body.user.tossAnimation).toBe(false);
    });
    expect((await t.api("GET", "/api/settings/budget")).body.tossAnimation).toBe(true); // the owner's is unchanged
  });

  it("notifications: each person's own switches (off for invited people) and their own emails, logged separately", async () => {
    const user = await join("user");
    await t.api("PUT", "/api/settings/notifications", { enabled: true, nudge: false, monthlySummary: false, monthlyInsights: false, bankAttention: false, overBudget: false, weekly: false, goalMilestones: false, largePurchase: false, newSignIn: false, monthCloseReminder: false, nextMonth: true });
    await as(user, async () => {
      const s = (await t.api("GET", "/api/settings/notifications")).body;
      expect(s.settings.enabled).toBe(false);
      expect(s.to).toBe("jess@example.com");
    });
    await t.api("POST", "/api/months/2026/10", { mode: "blank" });
    const nov28 = new Date(2026, 9, 29, 9); // Oct 29, 3 days before November

    expect((await runNotifications(t.db, t.app.mail, nov28, t.app.ai)).sent.map((s) => s.to)).toEqual(["sam@example.com"]);
    await as(user, () => t.api("PUT", "/api/settings/notifications", { enabled: true, nudge: false, monthlySummary: false, monthlyInsights: false, bankAttention: false, overBudget: false, weekly: false, goalMilestones: false, largePurchase: false, newSignIn: false, monthCloseReminder: false, nextMonth: true }));
    // Jess gets her own copy; the owner's isn't sent again
    const r = await runNotifications(t.db, t.app.mail, nov28, t.app.ai);
    expect(r.sent.map((s) => [s.to, s.key])).toEqual([["jess@example.com", "u2:next-month:2026-11"]]);
    expect((await runNotifications(t.db, t.app.mail, nov28, t.app.ai)).sent).toEqual([]);
    // Each send is its own line in Logs
    const lines: string[] = (await t.api("GET", "/api/logs?category=email")).body.map((l: any) => l.event);
    expect(lines.filter((e) => e.includes("to jess@example.com") && !e.includes("shared their budget"))).toHaveLength(1);
    expect(lines.filter((e) => e.includes("to sam@example.com"))).toHaveLength(1);
  });

  it("a sample goes to the person who asked for it", async () => {
    const user = await join("user");
    await as(user, async () => {
      const r = await t.api("POST", "/api/settings/notifications/test", { kind: "weekly" });
      expect(r.body).toMatchObject({ ok: true, to: "jess@example.com" });
    });
    expect(t.sent.at(-1)!.to).toBe("jess@example.com");
  });

  it("new sign-in alert goes to the person who signed in, if theirs is on", async () => {
    await join("user");
    await t.api("PUT", "/api/settings/notifications", { enabled: true, newSignIn: true });
    t.sent.length = 0;
    await t.api("POST", "/api/auth/login", { username: "jess", password: "password456" }, { "x-device-id": "jess-phone-1234567890" });
    await signInAlertSettled();
    expect(t.sent).toEqual([]); // Jess's notifications are off
    await t.api("POST", "/api/auth/login", { username: "sam", password: "password123" }, { "x-device-id": "sam-laptop-1234567890" });
    await signInAlertSettled();
    expect(t.sent.map((m) => m.to)).toEqual(["sam@example.com"]);
  });

  it("the owner changes a role or removes someone; the owner can't be changed or removed", async () => {
    const user = await join("user");
    const jess = (await t.api("GET", "/api/users")).body.people.find((p: any) => p.username === "jess");
    const owner = (await t.api("GET", "/api/users")).body.people.find((p: any) => p.role === "owner");
    expect((await t.api("PATCH", `/api/users/${jess.id}`, { role: "admin" })).body.role).toBe("admin");
    expect((await as(user, () => t.api("GET", "/api/keys"))).status).toBe(200); // takes effect right away
    expect((await t.api("PATCH", `/api/users/${owner.id}`, { role: "user" })).status).toBe(404);
    expect((await t.api("DELETE", `/api/users/${owner.id}`)).status).toBe(404);
    expect((await t.api("DELETE", `/api/users/${jess.id}`)).status).toBe(204);
    expect((await as(user, () => t.api("GET", "/api/months"))).status).toBe(401); // signed out
    const access = (await t.api("GET", "/api/logs?category=access")).body;
    expect(JSON.stringify(access)).toContain("Removed jess's access");
  });

  it("sign-in history: a user sees only their own; the owner sees everyone's", async () => {
    const user = await join("user");
    await t.api("POST", "/api/auth/login", { username: "nobody", password: "wrongwrong" });
    const mine = (await as(user, () => t.api("GET", "/api/auth/logins"))).body;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: any) => e.username === "jess")).toBe(true);
    const all = (await t.api("GET", "/api/auth/logins")).body;
    expect(all.some((e: any) => e.username === "nobody")).toBe(true);
  });

  it("forgot password: the link goes to whoever's username or email was typed", async () => {
    await join("user");
    t.setToken("");
    t.sent.length = 0;
    await t.api("POST", "/api/auth/forgot", { who: "Jess@Example.com" });
    expect(t.sent.map((m) => m.to)).toEqual(["jess@example.com"]);
  });
});
