import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());

// Fake AI (OpenAI format): reads the item list and transactions from the prompt and answers with a
// rule per merchant name. Records prompts so we can check what was sent.
let rules: Record<string, string | null> = {};
let prompts: string[] = [];
let raw: string | null = null;
function aiReply(_url: string, body: any) {
  const user: string = body.messages[1].content;
  prompts.push(user);
  if (raw !== null) return { status: 200, json: { choices: [{ message: { content: raw } }] } };
  const items = new Map<string, string>(); // item name -> code
  for (const line of user.split("\n")) {
    const m = /^([LI]\d+): .* > (.+)$/.exec(line);
    if (m) items.set(m[2], m[1]);
  }
  const results = user
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .map((tx) => {
      const want = rules[tx.merchant];
      return { id: tx.id, item: want === undefined ? null : want === null ? null : want.startsWith("!") ? want.slice(1) : items.get(want) ?? null, reason: `guess for ${tx.merchant}` };
    });
  return { status: 200, json: { choices: [{ message: { content: "```json\n" + JSON.stringify({ results }) + "\n```" } }] } };
}

let oct: any;
const item = (b: any, name: string) => b.groups.flatMap((g: any) => g.items).find((i: any) => i.name === name);
const add = async (b: any) => (await t.api("POST", "/api/transactions", b)).body;
const list = async () => (await t.api("GET", "/api/transactions?year=2026&month=10")).body;
const run = async (body: any = {}) => (await t.api("POST", "/api/transactions/ai-suggest", body)).body;

beforeEach(async () => {
  await t.reset();
  await t.login();
  rules = {};
  prompts = [];
  raw = null;
  t.ai.respond = aiReply;
  oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
  await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
});

describe("AI suggestions", () => {
  it("needs AI turned on", async () => {
    await t.api("PUT", "/api/settings/ai", { enabled: false, provider: "openai", model: "tiny", apiKey: "k", mode: "manual", maxPerRun: 50 });
    expect((await t.api("POST", "/api/transactions/ai-suggest", {})).body.error).toMatch(/isn't turned on/);
    expect((await t.api("GET", "/api/ai/status")).body).toEqual({ enabled: false, mode: null });
  });

  it("asks only about transactions history can't place, sends the month's items, and saves the guesses", async () => {
    await add({ date: "2026-10-01", merchant: "Trader Joe's", amountCents: 100, splits: [{ lineItemId: item(oct, "Groceries").id, amountCents: 100 }] });
    const known = await add({ date: "2026-10-08", merchant: "Trader Joe's", amountCents: 4000 });
    const vet = await add({ date: "2026-10-09", merchant: "Banfield Pet Hospital", amountCents: 12000, note: "Rex checkup" });
    const pay = await add({ date: "2026-10-15", merchant: "ACME CORP PAYROLL", amountCents: 250000, type: "income" });
    const weird = await add({ date: "2026-10-16", merchant: "XQZ*7781", amountCents: 999 });
    rules = { "Banfield Pet Hospital": "Pet Care", "ACME CORP PAYROLL": "Paycheck 1", "XQZ*7781": null };

    const r = await run();
    expect(r).toMatchObject({ asked: 3, suggested: 2, noMatch: 1 });
    expect(r.skipped).toContainEqual({ reason: "already have a suggestion from your history", count: 1 });
    // What was sent
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Budget items for 2026-10");
    expect(prompts[0]).toContain("Pets > Pet Care".replace("Pets", "Lifestyle"));
    expect(prompts[0]).toContain("Income > Paycheck 1");
    expect(prompts[0]).toContain('"merchant":"Banfield Pet Hospital"');
    expect(prompts[0]).toContain('"note":"Rex checkup"');
    expect(prompts[0]).toContain('"direction":"money in"');
    expect(prompts[0]).not.toContain("Trader Joe");

    const rows = await list();
    const by = (id: number) => rows.find((x: any) => x.id === id);
    expect(by(known.id).suggestion).toMatchObject({ itemName: "Groceries" });
    expect(by(known.id).aiSuggestion).toBeNull(); // history wins
    expect(by(vet.id).suggestion).toBeNull();
    expect(by(vet.id).aiSuggestion).toMatchObject({ itemName: "Pet Care", groupName: "Lifestyle", reason: "guess for Banfield Pet Hospital", model: "tiny" });
    expect(by(pay.id).aiSuggestion).toMatchObject({ itemName: "Paycheck 1", groupName: "Income" });
    expect(by(weird.id).aiSuggestion).toBeNull(); // no fit
    // Nothing assigned
    expect(rows.every((x: any) => x.merchant === "Trader Joe's" && x.date === "2026-10-01" ? true : x.splits.length === 0)).toBe(true);

    // Not asked twice; force asks again
    expect((await run()).asked).toBe(0);
    expect((await run({ ids: [weird.id], force: true })).asked).toBe(1);
  });

  it("accepting (one or all) uses history first, then the AI; accepted AI choices become history", async () => {
    await add({ date: "2026-10-01", merchant: "Trader Joe's", amountCents: 100, splits: [{ lineItemId: item(oct, "Groceries").id, amountCents: 100 }] });
    const tj = await add({ date: "2026-10-08", merchant: "Trader Joe's", amountCents: 4000 });
    const vet = await add({ date: "2026-10-09", merchant: "Banfield", amountCents: 12000 });
    const gym = await add({ date: "2026-10-10", merchant: "Planet Fitness", amountCents: 2500 });
    rules = { Banfield: "Pet Care", "Planet Fitness": "Gym" };
    await run();
    expect((await t.api("POST", `/api/transactions/${gym.id}/accept-suggestion`)).body.splits[0].lineItemId).toBe(item(oct, "Gym").id);
    expect((await t.api("POST", "/api/transactions/accept-suggestions", { ids: [tj.id, vet.id] })).body).toEqual({ assigned: 2 });
    const rows = await list();
    expect(rows.find((x: any) => x.id === vet.id).splits[0].lineItemId).toBe(item(oct, "Pet Care").id);
    // Next Banfield visit: history now knows it, so the AI isn't asked
    const again = await add({ date: "2026-10-20", merchant: "Banfield", amountCents: 5000 });
    prompts = [];
    const r = await run({ ids: [again.id] });
    expect(r.asked).toBe(0);
    expect((await list()).find((x: any) => x.id === again.id).suggestion).toMatchObject({ itemName: "Pet Care" });
  });

  it("only accepts codes from the right month and kind", async () => {
    const exp = await add({ date: "2026-10-09", merchant: "Shop A", amountCents: 100 });
    const exp2 = await add({ date: "2026-10-09", merchant: "Shop B", amountCents: 100 });
    rules = { "Shop A": "!I" + oct.income[0].id, "Shop B": "!L999999" }; // expense on income item; made-up item
    expect(await run()).toMatchObject({ asked: 2, suggested: 0, noMatch: 2 });
    const rows = await list();
    expect(rows.find((x: any) => x.id === exp.id).aiSuggestion).toBeNull();
    expect(rows.find((x: any) => x.id === exp2.id).aiSuggestion).toBeNull();
  });

  it("skips months with no budget, respects the per-run limit, batches by month", async () => {
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", mode: "manual", maxPerRun: 3 });
    await add({ date: "2026-07-01", merchant: "July thing", amountCents: 100 });
    await t.api("POST", "/api/months/2026/9", { mode: "template" });
    for (let i = 0; i < 4; i++) await add({ date: "2026-10-0" + (i + 1), merchant: "Oct " + i, amountCents: 100 });
    await add({ date: "2026-09-05", merchant: "Sep thing", amountCents: 100 });
    const r = await run();
    expect(r.asked).toBe(3);
    expect(r.skipped).toContainEqual({ reason: "in a month with no budget yet", count: 1 });
    expect(r.skipped).toContainEqual({ reason: "over the limit of 3 per run (they'll be asked next time)", count: 2 });
    expect((await run()).asked).toBe(2); // the rest
    expect(prompts.filter((p) => p.includes("Budget items for 2026-09"))).toHaveLength(1);
  });

  it("an AI failure saves nothing and is reported; garbage replies are ignored", async () => {
    const a = await add({ date: "2026-10-09", merchant: "Shop", amountCents: 100 });
    t.ai.respond = () => ({ status: 429, json: { error: { message: "quota exceeded" } } });
    const r = await run();
    expect(r.error).toMatch(/too many requests or out of credit: quota exceeded/);
    t.ai.respond = aiReply;
    raw = "I cannot help with that";
    expect(await run()).toMatchObject({ asked: 1, suggested: 0, noMatch: 0 });
    raw = null;
    rules = { Shop: "Miscellaneous" };
    expect(await run()).toMatchObject({ asked: 1, suggested: 1 }); // unanswered ones are asked again
    expect((await list()).find((x: any) => x.id === a.id).aiSuggestion).toMatchObject({ itemName: "Miscellaneous" });
  });

  it("editing the merchant clears the AI's guess; auto mode asks in the background", async () => {
    const a = await add({ date: "2026-10-09", merchant: "Shop", amountCents: 100 });
    rules = { Shop: "Miscellaneous", "Better Name": "Gym" };
    await run();
    await t.api("PUT", `/api/transactions/${a.id}`, { date: "2026-10-09", merchant: "Better Name", amountCents: 100 });
    expect((await list()).find((x: any) => x.id === a.id).aiSuggestion).toBeNull();

    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "openai", model: "tiny", mode: "auto", maxPerRun: 50 });
    expect((await t.api("GET", "/api/ai/status")).body).toEqual({ enabled: true, mode: "auto" });
    const b = await add({ date: "2026-10-10", merchant: "Shop", amountCents: 200 });
    for (let i = 0; i < 20 && !(await list()).find((x: any) => x.id === b.id).aiSuggestion; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await list()).find((x: any) => x.id === b.id).aiSuggestion).toMatchObject({ itemName: "Miscellaneous" });
  });

  it("× removes an AI guess; automatic runs leave it alone, Ask AI can ask again", async () => {
    const a = await add({ date: "2026-10-09", merchant: "Shop", amountCents: 100 });
    rules = { Shop: "Miscellaneous" };
    await run();
    expect((await list()).find((x: any) => x.id === a.id).aiSuggestion).toMatchObject({ itemName: "Miscellaneous" });
    expect((await t.api("DELETE", `/api/transactions/${a.id}/ai-suggestion`)).status).toBe(204);
    expect((await list()).find((x: any) => x.id === a.id).aiSuggestion).toBeNull();
    expect((await t.api("POST", `/api/transactions/${a.id}/accept-suggestion`)).status).toBe(400); // nothing to accept
    expect((await run()).asked).toBe(0); // not guessed again automatically
    expect((await run({ ids: [a.id], force: true })).suggested).toBe(1); // Ask AI
    expect((await t.api("DELETE", "/api/transactions/99999/ai-suggestion")).status).toBe(404);
  });
});
