import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestApp, type TestApp } from "./helpers.js";
import { runNotifications } from "../src/lib/notifications.js";
import { signInAlertSettled } from "../src/lib/sessions.js";

// The notifications added with the Settings › Notifications tab
let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

const run = (d: Date) => runNotifications(t.db, t.app.mail, d, t.app.ai);
const NONE = { monthCloseReminder: false, nudge: false, monthlySummary: false, monthlyInsights: false, bankAttention: false, overBudget: false, weekly: false, goalMilestones: false, largePurchase: false, nextMonth: false, newSignIn: false };
const only = (changes: object) => t.api("PUT", "/api/settings/notifications", { enabled: true, ...NONE, ...changes });

async function month(year: number, m: number) {
  const b = (await t.api("POST", `/api/months/${year}/${m}`, { mode: "blank" })).body;
  const inc = (await t.api("POST", `/api/months/${b.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const g = (await t.api("POST", `/api/months/${b.id}/groups`, { name: "Food" })).body;
  const groceries = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Groceries", plannedCents: 50000 })).body;
  const dining = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Dining Out", plannedCents: 10000 })).body;
  return { b, inc, groceries, dining };
}
const spend = (date: string, cents: number, lineItemId: number | null, merchant = "Shop") =>
  t.api("POST", "/api/transactions", { date, merchant, amountCents: cents, splits: lineItemId ? [{ lineItemId, amountCents: cents }] : [] });
const earn = (date: string, cents: number, incomeItemId: number) =>
  t.api("POST", "/api/transactions", { date, merchant: "Employer", amountCents: cents, type: "income", splits: [{ incomeItemId, amountCents: cents }] });

describe("more notifications", () => {
  it("settings: every notification has a switch, and the amounts are checked", async () => {
    const s = (await t.api("GET", "/api/settings/notifications")).body.settings;
    expect(s).toMatchObject({ monthlySummary: true, monthlySummaryAi: true, monthlyInsights: true, bankAttention: true, overBudget: true, weekly: true, weeklyDay: 0, goalMilestones: true, largePurchase: true, largePurchaseCents: 50000, nextMonth: true, nextMonthDays: 3, newSignIn: true });
    expect((await t.api("PUT", "/api/settings/notifications", { weeklyDay: 7 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/notifications", { largePurchaseCents: 50 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/notifications", { largePurchaseCents: 25000, weeklyDay: 5 })).body.settings).toMatchObject({ largePurchaseCents: 25000, weeklyDay: 5 });
  });

  it("settings saved before these existed: the monthly summary (a locked placeholder then) follows the new default", async () => {
    await t.db.execute(sql`insert into app_settings (key, value) values ('notifications', '{"enabled": true, "monthCloseReminder": true, "nudge": true, "nudgeDays": 7, "monthlySummary": false}')`);
    expect((await t.api("GET", "/api/settings/notifications")).body.settings).toMatchObject({ enabled: true, monthlySummary: true, weekly: true });
    await t.api("PUT", "/api/settings/notifications", { monthlySummary: false }); // turning it off now sticks
    expect((await t.api("GET", "/api/settings/notifications")).body.settings.monthlySummary).toBe(false);
  });

  it("monthly summary: last month, on the 1st after 8am, once (with the AI's lines when AI is on)", async () => {
    const sep = await month(2026, 9);
    await spend("2026-09-04", 62000, sep.groceries.id);
    await earn("2026-09-01", 300000, sep.inc.id);
    await only({ monthlySummary: true });
    expect((await run(new Date(2026, 9, 1, 7))).sent).toEqual([]); // before 8am
    const r = await run(new Date(2026, 9, 1, 9));
    expect(r.sent.map((x) => x.subject)).toEqual(["Your September 2026 summary"]);
    const text = t.sent.at(-1)!.text;
    expect(text).toContain("Income: $3,000");
    expect(text).toContain("Saved: 79%");
    expect(text).toContain("- Food ($600 planned, $20 over): $620");
    expect((await run(new Date(2026, 9, 2, 9))).sent).toEqual([]); // once

    // With AI on, a few lines from it; if it fails, the summary still goes out without them
    await t.db.execute(sql`delete from notification_log`);
    t.ai.respond = () => ({ status: 200, json: { choices: [{ message: { content: "- Food ran over by $20.\n- You saved most of your pay." } }] } });
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    await run(new Date(2026, 9, 1, 9));
    expect(t.sent.at(-1)!.text).toContain("- Food ran over by $20.");
    await t.db.execute(sql`delete from notification_log`);
    t.ai.respond = () => ({ status: 500, json: { error: { message: "down" } } });
    expect((await run(new Date(2026, 9, 1, 9))).sent).toHaveLength(1);
    expect(t.sent.at(-1)!.text).not.toContain("In short");
  });

  it("monthly insights: on the 2nd, trends, plans that keep missing, subscription changes, wins and a focus", async () => {
    const m = { 8: await month(2026, 8), 9: await month(2026, 9), 10: await month(2026, 10) };
    const day = (mo: number, d: number) => `2026-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    for (const [mo, dining, groceries] of [[8, 10000, 60000], [9, 14000, 62000], [10, 20000, 61000]] as const) {
      await spend(day(mo, 5), dining, m[mo].dining.id, "Bistro");
      await spend(day(mo, 6), groceries, m[mo].groceries.id, "Market");
      await earn(day(mo, 1), 300000, m[mo].inc.id);
    }
    await spend(day(8, 10), 1549, null, "Netflix");
    await spend(day(9, 10), 1549, null, "Netflix");
    await spend(day(10, 10), 1799, null, "Netflix"); // price went up
    await spend(day(9, 12), 1199, null, "Spotify");
    await spend(day(10, 12), 1199, null, "Spotify"); // new, now repeating
    await only({ monthlyInsights: true });
    expect((await run(new Date(2026, 10, 1, 9))).sent).toEqual([]); // the 1st is the summary's day
    const r = await run(new Date(2026, 10, 2, 9));
    expect(r.sent.map((x) => x.subject)).toEqual(["Your October 2026 insights"]);
    const text = t.sent.at(-1)!.text;
    expect(text).toContain("TRENDING UP\n- Dining Out (Food · $100 → $140 → $200): +$100");
    expect(text).toContain("- Groceries (Planned $500, spent $600, $620, $610): Plan $610");
    expect(text).toContain("- Netflix (Price went up from $15.49): $17.99");
    expect(text).toContain("- Spotify (New monthly charge): $11.99/mo");
    expect(text).toContain("Focus for November 2026: Plan $610 for Groceries in November 2026");
    expect((await run(new Date(2026, 10, 3, 9))).sent).toEqual([]); // once

    // With AI on: its intro and focus (the numbers stay the app's)
    await t.db.execute(sql`delete from notification_log`);
    t.ai.respond = () => ({ status: 200, json: { choices: [{ message: { content: '{"intro": "Eating out keeps climbing.", "focus": "Plan $610 for groceries."}' } }] } });
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    await run(new Date(2026, 10, 2, 9));
    const ai = t.sent.at(-1)!.text;
    expect(ai).toContain("Eating out keeps climbing.");
    expect(ai).toContain("Focus for November 2026: Plan $610 for groceries.");
    expect(ai).toContain("+$100"); // still the app's numbers
    expect(t.ai.calls.at(-1)!.body.messages.map((x: { content: string }) => x.content).join("\n")).toContain("Rising 3 months in a row: Dining Out (Food) $100 -> $140 -> $200.");
  });

  it("bank needs attention: once per problem, and again after it was fixed and broke again", async () => {
    await t.api("PUT", "/api/settings/features", { plaid: true });
    await t.db.execute(sql`insert into plaid_items (item_id, access_token_enc, env, institution_name, import_from, status, error_message) values ('i1', 'x', 'sandbox', 'Mountain America', '2026-01-01', 'login_required', 'the login details changed')`);
    await only({ bankAttention: true });
    const r = await run(new Date(2026, 9, 20, 10));
    expect(r.sent.map((x) => x.subject)).toEqual(["Mountain America needs you to sign in again"]);
    expect(t.sent.at(-1)!.text).toContain("The bank said: the login details changed");
    expect((await run(new Date(2026, 9, 20, 11))).sent).toEqual([]);
    await t.db.execute(sql`update plaid_items set status = 'ok'`);
    await run(new Date(2026, 9, 20, 12));
    await t.db.execute(sql`update plaid_items set status = 'error'`);
    expect((await run(new Date(2026, 9, 20, 13))).sent.map((x) => x.subject)).toEqual(["Mountain America stopped updating"]);
    // Plaid switched off in Settings: no bank emails
    await t.db.execute(sql`delete from notification_log`);
    await t.api("PUT", "/api/settings/features", { plaid: false });
    expect((await run(new Date(2026, 9, 20, 14))).sent).toEqual([]);
  });

  it("over budget: once per item per month, one email for the new ones; fund items left out", async () => {
    const oct = await month(2026, 10);
    const fund = (await t.api("POST", "/api/funds", { name: "Car" })).body;
    await t.api("PATCH", `/api/items/${oct.groceries.id}`, { sinkingFundId: fund.id });
    await only({ overBudget: true });
    await spend("2026-10-03", 70000, oct.groceries.id); // over, but it's a fund item
    await spend("2026-10-04", 15000, oct.dining.id);
    const r = await run(new Date(2026, 9, 5, 10));
    expect(r.sent.map((x) => x.subject)).toEqual(["Dining Out is over budget"]);
    expect(t.sent.at(-1)!.text).toContain("- Dining Out (Food · $150 of $100): $50 over");
    await spend("2026-10-06", 100, oct.dining.id);
    expect((await run(new Date(2026, 9, 6, 10))).sent).toEqual([]); // already told
  });

  it("weekly check-in: on the chosen day after 8am, when the month has a budget", async () => {
    const oct = await month(2026, 10);
    await spend("2026-10-20", 4500, oct.groceries.id, "Costco");
    await spend("2026-10-22", 9500, oct.dining.id, "Steakhouse"); // dining now $95 of $100: almost used up
    await spend("2026-10-01", 99999, oct.groceries.id, "Old"); // not this week
    await only({ weekly: true, weeklyDay: 0 });
    expect((await run(new Date(2026, 9, 24, 9))).sent).toEqual([]); // Saturday
    const r = await run(new Date(2026, 9, 25, 9)); // Sunday
    expect(r.sent.map((x) => x.subject)).toEqual(["Your week: $140 spent, -$540 left"]);
    const text = t.sent.at(-1)!.text;
    expect(text).toContain("- Steakhouse: $95");
    expect(text).toContain("ALMOST USED UP\n- Dining Out: $5 left");
    expect(text).toContain("Days left: 7");
    expect((await run(new Date(2026, 9, 25, 15))).sent).toEqual([]);
  });

  it("goal milestones: the newest step reached, once; reaching the target; falling behind", async () => {
    const goal = (await t.api("POST", "/api/funds", { name: "Vacation", kind: "goal", targetCents: 100000, startingBalanceCents: 60000 })).body;
    await only({ goalMilestones: true });
    const now = new Date();
    expect((await run(now)).sent.map((x) => x.subject)).toEqual(["Vacation: 50% of the way there"]);
    expect((await run(now)).sent).toEqual([]);
    await t.api("POST", `/api/funds/${goal.id}/entries`, { amountCents: 40000, date: now.toISOString().slice(0, 10), description: "Gift" });
    expect((await run(now)).sent.map((x) => x.subject)).toEqual(["You reached your Vacation goal!"]);

    // Behind: started in January, due in December, nothing saved by October
    await t.db.execute(sql`delete from sinking_funds`);
    await t.db.execute(sql`delete from notification_log`);
    const late = (await t.api("POST", "/api/funds", { name: "Roof", kind: "goal", targetCents: 120000, targetDate: "2026-12" })).body;
    await t.db.execute(sql`update sinking_funds set created_at = '2026-01-15' where id = ${late.id}`);
    const r = await run(new Date(2026, 9, 10, 9));
    expect(r.sent.map((x) => x.subject)).toEqual(["Roof is falling behind"]);
    expect(t.sent.at(-1)!.text).toContain("plan about $400 a month");
    expect((await run(new Date(2026, 9, 20, 9))).sent).toEqual([]); // once a month
  });

  it("large purchase: new ones over the amount, once each", async () => {
    await only({ largePurchase: true, largePurchaseCents: 50000 });
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await spend(iso, 64999, null, "Furniture Mart");
    await spend(iso, 49999, null, "Just under");
    await spend("2020-01-01", 900000, null, "Old history"); // imported old history: no alert
    const r = await run(today);
    expect(r.sent.map((x) => x.subject)).toEqual(["Large purchase: $649.99 at Furniture Mart"]);
    expect((await run(today)).sent).toEqual([]);
  });

  it("next month isn't set up: a few days before it starts", async () => {
    await month(2026, 10);
    await only({ nextMonth: true, nextMonthDays: 3 });
    expect((await run(new Date(2026, 9, 28, 9))).sent).toEqual([]); // 4 days before
    expect((await run(new Date(2026, 9, 29, 9))).sent.map((x) => x.subject)).toEqual(["Set up your November 2026 budget"]);
    expect((await run(new Date(2026, 9, 30, 9))).sent).toEqual([]);
    await t.db.execute(sql`delete from notification_log`);
    await t.api("POST", "/api/months/2026/11", { mode: "copy" });
    expect((await run(new Date(2026, 9, 30, 9))).sent).toEqual([]); // it's set up now
  });

  it("new sign-in: the first time a browser signs in, right away", async () => {
    await only({ newSignIn: true });
    const login = (device: string) => t.api("POST", "/api/auth/login", { username: "cory", password: "password123" }, { "x-device-id": device, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    const before = t.sent.length;
    expect((await login("phone-device-0001")).status).toBe(200);
    await signInAlertSettled();
    expect(t.sent.length).toBe(before + 1);
    expect(t.sent.at(-1)!.subject).toBe("New sign-in: Safari on iPhone");
    expect(t.sent.at(-1)!.text).toContain("Signed in with: password");
    await login("phone-device-0001"); // same browser again
    await signInAlertSettled();
    expect(t.sent.length).toBe(before + 1);
    await t.api("PUT", "/api/settings/notifications", { newSignIn: false });
    await login("laptop-device-0001");
    await signInAlertSettled();
    expect(t.sent.length).toBe(before + 1);
  });

  it("every notification has a sample, marked [Test]", async () => {
    for (const kind of ["summary", "insights", "bank", "over-budget", "weekly", "goal", "large-purchase", "next-month", "sign-in"]) {
      const r = await t.api("POST", "/api/settings/notifications/test", { kind });
      expect(r.status, kind).toBe(200);
      expect(t.sent.at(-1)!.subject, kind).toMatch(/^\[Test\] /);
      expect((await t.api("GET", `/api/settings/notifications/preview?kind=${kind}`)).status, kind).toBe(200);
    }
  });
});

describe("transfer items in emails", () => {
  async function withTransfer(year = 2026, m = 10) {
    const oct = await month(year, m);
    const g = (await t.api("GET", `/api/months/${year}/${m}`)).body.groups[0];
    const transfer = (await t.api("POST", `/api/groups/${g.id}/items`, { name: "Transfer", plannedCents: 0 })).body;
    await t.api("PATCH", `/api/items/${transfer.id}`, { isTransfer: true });
    return { ...oct, transfer };
  }

  it("no over-budget email for a transfer item", async () => {
    const oct = await withTransfer();
    await only({ overBudget: true });
    await spend("2026-10-03", 30000, oct.transfer.id, "To savings");
    await spend("2026-10-04", 15000, oct.dining.id);
    const r = await run(new Date(2026, 9, 5, 10));
    expect(r.sent.map((x) => x.subject)).toEqual(["Dining Out is over budget"]);
    expect(t.sent.at(-1)!.text).not.toContain("Transfer");
  });

  it("no large-purchase email for a transfer; a split with a normal item still alerts", async () => {
    const today = new Date();
    const oct = await withTransfer(today.getFullYear(), today.getMonth() + 1); // this month: transactions are dated today
    await only({ largePurchase: true, largePurchaseCents: 50000 });
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await spend(iso, 90000, oct.transfer.id, "To savings");
    expect((await run(today)).sent).toEqual([]);
    await t.api("POST", "/api/transactions", {
      date: iso, merchant: "Furniture Mart", amountCents: 90000,
      splits: [{ lineItemId: oct.transfer.id, amountCents: 30000 }, { lineItemId: oct.groceries.id, amountCents: 60000 }],
    });
    expect((await run(today)).sent.map((x) => x.subject)).toEqual(["Large purchase: $900.00 at Furniture Mart"]);
  });

  it("weekly check-in leaves out transfers", async () => {
    const oct = await withTransfer();
    await spend("2026-10-20", 4500, oct.groceries.id, "Costco");
    await spend("2026-10-21", 80000, oct.transfer.id, "To savings");
    await only({ weekly: true, weeklyDay: 0 });
    const r = await run(new Date(2026, 9, 25, 9)); // Sunday
    expect(r.sent.map((x) => x.subject)).toEqual(["Your week: $45 spent, $555 left"]);
    const text = t.sent.at(-1)!.text;
    expect(text).not.toContain("To savings");
    expect(text).not.toContain("Transfer");
  });
});
