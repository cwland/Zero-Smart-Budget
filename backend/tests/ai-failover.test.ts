import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());

const HOME = "http://10.0.0.5:11434/v1";
// Which servers are down / hanging, and what each one says per merchant
let down: Set<string>;
let hang: Set<string>;
let picks: Record<string, Record<string, string | null>>; // server -> merchant -> item name
const serverOf = (url: string) => (url.startsWith(HOME) ? "home" : "cloud");

function reply(url: string, body: any) {
  const who = serverOf(url);
  if (hang.has(who)) return new Promise<never>(() => {});
  if (down.has(who)) return { status: 503, json: { error: { message: "loading model" } } };
  const user: string = body.messages[1].content;
  const items = new Map<string, string>();
  for (const line of user.split("\n")) {
    const m = /^([LI]\d+): .* > (.+)$/.exec(line);
    if (m) items.set(m[2], m[1]);
  }
  const results = user
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .map((tx) => ({ id: tx.id, item: picks[who]?.[tx.merchant] ? items.get(picks[who][tx.merchant]!) ?? null : null, reason: `${who} says` }));
  return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ results }) } }] } };
}

let oct: any;
const settings = (extra: object = {}) => ({
  enabled: true,
  mode: "manual",
  maxPerRun: 50,
  timeoutSec: 3,
  services: [
    { name: "Home AI", provider: "local", baseUrl: HOME, model: "qwen" },
    { name: "Cloud backup", provider: "openrouter", apiKey: "or-key", model: "small" },
  ],
  ...extra,
});
const add = async (merchant: string) => (await t.api("POST", "/api/transactions", { date: "2026-10-05", merchant, amountCents: 1000 })).body;
const chips = async () => Object.fromEntries((await t.api("GET", "/api/transactions?year=2026&month=10")).body.map((x: any) => [x.merchant, x.aiSuggestion ? `${x.aiSuggestion.itemName} by ${x.aiSuggestion.service}` : null]));

beforeEach(async () => {
  await t.reset();
  await t.login();
  down = new Set();
  hang = new Set();
  picks = { home: { Starbucks: "Restaurants" }, cloud: { Starbucks: "Restaurants", "Steam Games": "Entertainment" } };
  t.ai.respond = reply as any;
  oct = (await t.api("POST", "/api/months/2026/10", { mode: "template" })).body;
});

describe("backup AI services", () => {
  it("saves a list in order, with each key kept and shown", async () => {
    const r = (await t.api("PUT", "/api/settings/ai", settings())).body.settings;
    expect(r.services.map((s: any) => [s.name, s.provider, s.apiKey])).toEqual([
      ["Home AI", "local", null],
      ["Cloud backup", "openrouter", "or-key"],
    ]);
    // Reorder (drag): send them the other way round; the key stays with its service
    const [home, cloud] = r.services;
    const again = (await t.api("PUT", "/api/settings/ai", { ...settings(), services: [{ ...cloud, apiKey: undefined }, home] })).body.settings;
    expect(again.services.map((s: any) => [s.name, s.apiKey])).toEqual([
      ["Cloud backup", "or-key"],
      ["Home AI", null],
    ]);
    // A service turned on needs a model; one turned off doesn't
    const bad = await t.api("PUT", "/api/settings/ai", { ...settings(), services: [{ name: "X", provider: "openai", model: "" }] });
    expect(bad.body.details[0].message).toBe("Choose a model");
    expect((await t.api("PUT", "/api/settings/ai", { ...settings(), services: [{ name: "X", provider: "openai", model: "", enabled: false }, settings().services[0]] })).status).toBe(200);
  });

  it("uses the first service, and the next when the first is down", async () => {
    await t.api("PUT", "/api/settings/ai", settings());
    await add("Starbucks");
    let r = (await t.api("POST", "/api/transactions/ai-suggest", {})).body;
    expect(r).toMatchObject({ suggested: 1, services: { "Home AI": 1 } });
    expect(r.warnings).toBeUndefined();
    expect((await chips()).Starbucks).toBe("Restaurants by Home AI");

    down.add("home");
    r = (await t.api("POST", "/api/transactions/ai-suggest", { force: true })).body;
    expect(r).toMatchObject({ suggested: 1, services: { "Cloud backup": 1 } });
    expect(r.warnings[0]).toMatch(/^Home AI: The AI service returned 503/);
    expect((await chips()).Starbucks).toBe("Restaurants by Cloud backup");
  });

  it("moves on when a service hangs past the timeout", async () => {
    await t.api("PUT", "/api/settings/ai", settings());
    await add("Starbucks");
    hang.add("home");
    const r = (await t.api("POST", "/api/transactions/ai-suggest", {})).body;
    expect(r.services).toEqual({ "Cloud backup": 1 });
    expect(r.warnings[0]).toBe("Home AI: The AI service didn't answer within 3 seconds.");
  }, 10000);

  it("all down: says so, and saves nothing", async () => {
    await t.api("PUT", "/api/settings/ai", settings());
    await add("Starbucks");
    down.add("home").add("cloud");
    const r = (await t.api("POST", "/api/transactions/ai-suggest", {})).body;
    expect(r.error).toMatch(/^None of your AI services answered\. Home AI: .* Cloud backup: /);
    expect((await chips()).Starbucks).toBeNull();
  });

  it("ask the next AI when one finds no good fit", async () => {
    await add("Starbucks");
    await add("Steam Games");
    // Off: Home AI's "no fit" stands
    await t.api("PUT", "/api/settings/ai", settings());
    await t.api("POST", "/api/transactions/ai-suggest", {});
    expect(await chips()).toEqual({ Starbucks: "Restaurants by Home AI", "Steam Games": null });

    // On: Steam Games goes on to the cloud service
    await t.api("PUT", "/api/settings/ai", settings({ askNextOnNoMatch: true }));
    const r = (await t.api("POST", "/api/transactions/ai-suggest", { force: true })).body;
    expect(r).toMatchObject({ asked: 2, suggested: 2, noMatch: 0, services: { "Home AI": 1, "Cloud backup": 1 } });
    expect(await chips()).toEqual({ Starbucks: "Restaurants by Home AI", "Steam Games": "Entertainment by Cloud backup" });

    // Nobody knows it: "no fit" from the last one asked
    await add("Mystery Shop");
    await t.api("POST", "/api/transactions/ai-suggest", {});
    const all = (await t.api("GET", "/api/transactions?year=2026&month=10")).body;
    expect(all.find((x: any) => x.merchant === "Mystery Shop").aiSuggestion).toBeNull();
    expect(t.ai.calls.filter((c) => c.body.messages[1].content.includes("Mystery Shop")).length).toBe(2); // home, then cloud
  });

  it("settings saved the old way become the first service", async () => {
    await t.api("PUT", "/api/settings/ai", { enabled: true, provider: "local", baseUrl: HOME, model: "qwen", mode: "manual", maxPerRun: 50 });
    const s = (await t.api("GET", "/api/settings/ai")).body.settings;
    expect(s.services).toHaveLength(1);
    expect(s.services[0]).toMatchObject({ name: "Home AI", provider: "local", model: "qwen" });
    expect(s).toMatchObject({ timeoutSec: 15, askNextOnNoMatch: false });
  });
});
