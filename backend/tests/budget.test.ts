import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

async function makeOctober() {
  const month = (await t.api("POST", "/api/months/2026/10", { mode: "blank" })).body;
  const pay = (await t.api("POST", `/api/months/${month.id}/income`, { name: "Paycheck", plannedCents: 300000 })).body;
  const housing = (await t.api("POST", `/api/months/${month.id}/groups`, { name: "Housing" })).body;
  const food = (await t.api("POST", `/api/months/${month.id}/groups`, { name: "Food" })).body;
  const rent = (await t.api("POST", `/api/groups/${housing.id}/items`, { name: "Rent", plannedCents: 150000 })).body;
  const groceries = (await t.api("POST", `/api/groups/${food.id}/items`, { name: "Groceries", plannedCents: 60000 })).body;
  return { month, pay, housing, food, rent, groceries };
}

describe("months", () => {
  it("a missing month says it doesn't exist", async () => {
    const res = await t.api("GET", "/api/months/2026/10");
    expect(res.body).toEqual({ exists: false, year: 2026, month: 10, canCopyFrom: null, waitingTransactions: 0 });
  });

  it("creates a blank month once", async () => {
    expect((await t.api("POST", "/api/months/2026/10", { mode: "blank" })).status).toBe(201);
    expect((await t.api("POST", "/api/months/2026/10", { mode: "blank" })).status).toBe(409);
    expect((await t.api("GET", "/api/months")).body).toHaveLength(1);
  });

  it("rejects bad month numbers", async () => {
    expect((await t.api("GET", "/api/months/2026/13")).status).toBe(400);
  });

  it("calculates left to budget", async () => {
    const { month } = await makeOctober();
    const budget = (await t.api("GET", "/api/months/2026/10")).body;
    expect(budget.exists).toBe(true);
    expect(budget.id).toBe(month.id);
    expect(budget.totals.incomePlannedCents).toBe(300000);
    expect(budget.totals.plannedCents).toBe(210000);
    expect(budget.totals.leftToBudgetCents).toBe(90000);
    expect(budget.groups.map((g: { name: string }) => g.name)).toEqual(["Housing", "Food"]);
    expect(budget.groups[0].plannedCents).toBe(150000);
  });

  it("copies the most recent earlier month, even with a gap", async () => {
    const { month, rent } = await makeOctober();
    expect((await t.api("GET", "/api/months/2026/12")).body.canCopyFrom).toEqual({ year: 2026, month: 10 });

    const copy = await t.api("POST", "/api/months/2026/12", { mode: "copy" });
    expect(copy.status).toBe(201);
    expect(copy.body.id).not.toBe(month.id);
    expect(copy.body.income[0]).toMatchObject({ name: "Paycheck", plannedCents: 300000, receivedCents: 0 });
    expect(copy.body.groups[0].items[0]).toMatchObject({ name: "Rent", plannedCents: 150000, spentCents: 0 });
    expect(copy.body.groups[0].items[0].id).not.toBe(rent.id);
    expect(copy.body.totals.leftToBudgetCents).toBe(90000);

    // Editing the copy doesn't change the original
    await t.api("PATCH", `/api/items/${copy.body.groups[0].items[0].id}`, { plannedCents: 1 });
    const oct = (await t.api("GET", "/api/months/2026/10")).body;
    expect(oct.groups[0].items[0].plannedCents).toBe(150000);
  });

  it("template mode adds starter income and groups", async () => {
    const res = await t.api("POST", "/api/months/2026/10", { mode: "template" });
    expect(res.status).toBe(201);
    expect(res.body.income.map((i: { name: string }) => i.name)).toEqual(["Paycheck 1", "Paycheck 2"]);
    expect(res.body.groups[0].name).toBe("Giving");
    expect(res.body.groups.find((g: { name: string }) => g.name === "Food").items.map((i: { name: string }) => i.name)).toEqual(["Groceries", "Restaurants"]);
    expect(res.body.totals.leftToBudgetCents).toBe(0);
  });

  it("copy fails when there's nothing earlier", async () => {
    expect((await t.api("POST", "/api/months/2026/10", { mode: "copy" })).status).toBe(400);
  });

  it("deleting a month removes its groups and items", async () => {
    const { month } = await makeOctober();
    expect((await t.api("DELETE", `/api/months/${month.id}`)).status).toBe(204);
    expect((await t.api("GET", "/api/months/2026/10")).body.exists).toBe(false);
  });
});

describe("income, groups and items", () => {
  it("renames, re-amounts and deletes", async () => {
    const { pay, housing, rent } = await makeOctober();
    expect((await t.api("PATCH", `/api/income/${pay.id}`, { name: "Main job", plannedCents: 310000 })).body).toMatchObject({ name: "Main job", plannedCents: 310000 });
    expect((await t.api("PATCH", `/api/groups/${housing.id}`, { name: "Home" })).body.name).toBe("Home");
    expect((await t.api("PATCH", `/api/items/${rent.id}`, { plannedCents: 155050 })).body.plannedCents).toBe(155050);
    expect((await t.api("DELETE", `/api/items/${rent.id}`)).status).toBe(204);
    expect((await t.api("DELETE", `/api/items/${rent.id}`)).status).toBe(404);
    const budget = (await t.api("GET", "/api/months/2026/10")).body;
    expect(budget.groups[0].items).toHaveLength(0);
    expect(budget.totals.leftToBudgetCents).toBe(310000 - 60000);
  });

  it("rejects fractional cents and negative amounts", async () => {
    const { rent } = await makeOctober();
    expect((await t.api("PATCH", `/api/items/${rent.id}`, { plannedCents: 10.5 })).status).toBe(400);
    expect((await t.api("PATCH", `/api/items/${rent.id}`, { plannedCents: -1 })).status).toBe(400);
  });

  it("reorders groups and items", async () => {
    const { month, housing, food } = await makeOctober();
    const extra = (await t.api("POST", `/api/groups/${food.id}/items`, { name: "Restaurants" })).body;
    const groceries = (await t.api("GET", "/api/months/2026/10")).body.groups[1].items[0];

    expect((await t.api("PUT", `/api/months/${month.id}/groups/order`, { ids: [food.id, housing.id] })).status).toBe(200);
    expect((await t.api("PUT", `/api/groups/${food.id}/items/order`, { ids: [extra.id, groceries.id] })).status).toBe(200);
    const budget = (await t.api("GET", "/api/months/2026/10")).body;
    expect(budget.groups.map((g: { name: string }) => g.name)).toEqual(["Food", "Housing"]);
    expect(budget.groups[0].items.map((i: { name: string }) => i.name)).toEqual(["Restaurants", "Groceries"]);

    // Must list every id exactly once
    expect((await t.api("PUT", `/api/months/${month.id}/groups/order`, { ids: [food.id] })).status).toBe(400);
  });

  it("moves an item to another group in the same month only", async () => {
    const { food, rent } = await makeOctober();
    expect((await t.api("PATCH", `/api/items/${rent.id}`, { groupId: food.id })).body.groupId).toBe(food.id);

    const nov = (await t.api("POST", "/api/months/2026/11", { mode: "blank" })).body;
    const novGroup = (await t.api("POST", `/api/months/${nov.id}/groups`, { name: "X" })).body;
    expect((await t.api("PATCH", `/api/items/${rent.id}`, { groupId: novGroup.id })).status).toBe(400);
  });
});

describe("favorites", () => {
  it("star an item; it stays in its group, is flagged in the budget, and carries to copied months", async () => {
    const { food, groceries, rent } = await makeOctober();
    expect((await t.api("PATCH", `/api/items/${groceries.id}`, { favorite: true })).body.favorite).toBe(true);
    await t.api("PATCH", `/api/items/${rent.id}`, { favorite: true });
    let b = (await t.api("GET", "/api/months/2026/10")).body;
    const all = b.groups.flatMap((g: any) => g.items);
    expect(all.filter((i: any) => i.favorite).map((i: any) => i.name)).toEqual(["Rent", "Groceries"]);
    expect(b.groups.find((g: any) => g.id === food.id).items[0]).toMatchObject({ name: "Groceries", favorite: true });

    const nov = (await t.api("POST", "/api/months/2026/11", { mode: "copy" })).body;
    expect(nov.groups.flatMap((g: any) => g.items).filter((i: any) => i.favorite).map((i: any) => i.name)).toEqual(["Rent", "Groceries"]);

    await t.api("PATCH", `/api/items/${groceries.id}`, { favorite: false });
    b = (await t.api("GET", "/api/months/2026/10")).body;
    expect(b.groups.flatMap((g: any) => g.items).filter((i: any) => i.favorite).map((i: any) => i.name)).toEqual(["Rent"]);
  });
});
