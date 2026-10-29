import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
  t.clock.date = new Date(2026, 9, 15, 12); // October 15, 2026
});
afterAll(async () => t.close());

describe("goals", () => {
  it("adds a goal to this month's budget with the monthly amount needed", async () => {
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
    // $1,200 by March 2027 with $200 saved: $1,000 over 6 months (Oct..Mar) = $166.67/month
    const r = (await t.api("POST", "/api/goals", { name: "Emergency Fund", targetCents: 120000, targetDate: "2027-03", startingBalanceCents: 20000 })).body;
    expect(r.goal).toMatchObject({ kind: "goal", targetDate: "2027-03-01" });
    expect(r.plan).toMatchObject({ neededCents: 100000, monthsLeft: 6, monthlyCents: 16667, overdue: false });
    expect(r.addedTo).toMatchObject({ year: 2026, month: 10, groupName: "Goals", plannedCents: 16667 });

    const b = (await t.api("GET", "/api/months/2026/10")).body;
    const group = b.groups.find((g: any) => g.name === "Goals");
    expect(group.items[0]).toMatchObject({ name: "Emergency Fund", plannedCents: 16667, sinkingFund: { id: r.goal.id, kind: "goal", balanceCents: 36667 } });
    // A second goal joins the same group
    await t.api("POST", "/api/goals", { name: "New Car", targetCents: 500000 , targetDate: "2027-09" });
    expect((await t.api("GET", "/api/months/2026/10")).body.groups.filter((g: any) => g.name === "Goals")[0].items).toHaveLength(2);
    expect(oct.id).toBe(b.id);

    // The funds list carries the plan, worked out before October's own line (so it doesn't shrink)
    const listed = (await t.api("GET", "/api/funds")).body.find((f: any) => f.id === r.goal.id);
    expect(listed).toMatchObject({ balanceCents: 36667, plan: { neededCents: 100000, monthsLeft: 6, monthlyCents: 16667 } });
  });

  it("isn't added to the budget when there's no month yet, or it's closed, or no date", async () => {
    expect((await t.api("POST", "/api/goals", { name: "A", targetCents: 1000, targetDate: "2027-01" })).body.addedTo).toBeNull();
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
    expect((await t.api("POST", "/api/goals", { name: "B", targetCents: 1000 })).body).toMatchObject({ addedTo: null, plan: { monthlyCents: null } });
    await t.api("POST", `/api/months/${oct.id}/close`, {});
    expect((await t.api("POST", "/api/goals", { name: "C", targetCents: 1000, targetDate: "2027-01" })).body.addedTo).toBeNull();
    expect((await t.api("POST", "/api/goals", { name: "D", targetCents: 0 })).status).toBe(400);
    expect((await t.api("POST", "/api/goals", { name: "E", targetCents: 10, targetDate: "2027-13" })).status).toBe(400);
  });

  it("past its date and not reached: overdue", async () => {
    await t.api("POST", "/api/goals", { name: "Late", targetCents: 1000, targetDate: "2026-08" });
    const f = (await t.api("GET", "/api/funds")).body[0];
    expect(f.plan).toMatchObject({ monthsLeft: 0, overdue: true, monthlyCents: 1000 });
  });

  it("copying a month only saves what a goal still needs, then nothing once reached", async () => {
    t.clock.date = new Date(2026, 8, 10, 12);
    await t.api("POST", "/api/months/2026/9", { mode: "blank" });
    const g = (await t.api("POST", "/api/goals", { name: "Bike", targetCents: 50000, targetDate: "2026-10", startingBalanceCents: 10000 })).body;
    expect(g.addedTo.plannedCents).toBe(20000); // $400 over Sep + Oct
    // Raise September's line by hand so October needs less
    await t.api("PATCH", `/api/items/${g.addedTo.itemId}`, { plannedCents: 30000 });
    const oct = (await t.api("POST", "/api/months/2026/10", { mode: "copy" })).body;
    expect(oct.groups[0].items[0]).toMatchObject({ plannedCents: 10000, sinkingFund: { balanceCents: 50000, goalReached: true } });
    const nov = (await t.api("POST", "/api/months/2026/11", { mode: "copy" })).body;
    expect(nov.groups[0].items[0].plannedCents).toBe(0);
    // Sinking funds still copy their full amount
    expect(oct.totals.leftToBudgetCents).toBe(-10000);
  });

  it("edits a goal's date, and the fund kind can switch only with a target", async () => {
    const g = (await t.api("POST", "/api/goals", { name: "Trip", targetCents: 30000, targetDate: "2027-06" })).body.goal;
    expect((await t.api("PATCH", `/api/funds/${g.id}`, { targetDate: "2027-12" })).body.targetDate).toBe("2027-12-01");
    const s = (await t.api("POST", "/api/funds", { name: "Gifts" })).body;
    expect((await t.api("PATCH", `/api/funds/${s.id}`, { kind: "goal" })).status).toBe(400);
    expect((await t.api("PATCH", `/api/funds/${s.id}`, { kind: "goal", targetCents: 5000 })).body.kind).toBe("goal");
  });
});
