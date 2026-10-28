import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { parseJsonReply } from "../src/lib/ai.js";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
beforeEach(async () => {
  await t.reset();
  await t.login();
});
afterAll(async () => t.close());

const base = { enabled: true, mode: "auto", maxPerRun: 50 };

// A fake that answers in each provider's own format
function fake(url: string, body: any) {
  const ok = '{"ok": true}';
  if (url.endsWith("/models") || url.includes("/models?")) {
    if (url.includes("generativelanguage")) return { status: 200, json: { models: [{ name: "models/gem-b", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed-x", supportedGenerationMethods: ["embedContent"] }, { name: "models/gem-a" }] } };
    if (url.includes("11434")) return { status: 200, json: { data: [{ id: "llama-local" }, { id: "qwen-local" }] } };
    return { status: 200, json: { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] } };
  }
  if (url.includes("api.anthropic.com")) return { status: 200, json: { content: [{ type: "text", text: ok }] } };
  if (url.includes("generativelanguage")) return { status: 200, json: { candidates: [{ content: { parts: [{ text: "```json\n" + ok + "\n```" }] } }] } };
  return { status: 200, json: { choices: [{ message: { content: ok } }] } };
}

describe("AI settings", () => {
  it("starts empty, saves the key encrypted, returns it only to the signed-in page", async () => {
    expect((await t.api("GET", "/api/settings/ai")).body).toEqual({ settings: null });
    const r = await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "model-a", apiKey: "sk-secret-123" });
    expect(r.body.settings).toMatchObject({ enabled: true, provider: "openai", model: "model-a", apiKey: "sk-secret-123", mode: "auto", maxPerRun: 50, baseUrl: null, apiKeyUnreadable: false });
    const raw = JSON.stringify((await t.db.execute(sql`select value from app_settings where key = 'ai'`)).rows);
    expect(raw).not.toContain("sk-secret-123");
    const key = (await t.api("POST", "/api/keys", { name: "n8n" })).body.key;
    const token = t.getToken();
    t.setToken("");
    expect((await t.api("GET", "/api/settings/ai", undefined, { "x-api-key": key })).status).toBe(403);
    t.setToken(token);
  });

  it("blank key keeps the saved one; empty removes it; local needs an address; validation", async () => {
    await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "m", apiKey: "k1" });
    await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "m2", mode: "manual" });
    expect((await t.api("GET", "/api/settings/ai")).body.settings).toMatchObject({ model: "m2", apiKey: "k1", mode: "manual" });
    await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "m2", apiKey: "" });
    expect((await t.api("GET", "/api/settings/ai")).body.settings.apiKey).toBeNull();
    expect((await t.api("PUT", "/api/settings/ai", { ...base, provider: "local", model: "x" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/ai", { ...base, provider: "local", model: "x", baseUrl: "ftp://x" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings/ai", { ...base, enabled: false, provider: "openai", model: "" })).status).toBe(200); // off: no model needed
    expect((await t.api("PUT", "/api/settings/ai", { ...base, provider: "nope", model: "x" })).status).toBe(400);
  });

  it("tests each provider with its own URL, auth header and request shape", async () => {
    t.ai.respond = fake;
    const cases = [
      { provider: "openai", url: "https://api.openai.com/v1/chat/completions", header: ["authorization", "Bearer KEY"] },
      { provider: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", header: ["authorization", "Bearer KEY"] },
      { provider: "anthropic", url: "https://api.anthropic.com/v1/messages", header: ["x-api-key", "KEY"] },
      { provider: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models/gem-a:generateContent", header: ["x-goog-api-key", "KEY"] },
      { provider: "local", url: "http://192.168.1.20:11434/v1/chat/completions", header: null, baseUrl: "http://192.168.1.20:11434/v1/" },
    ] as const;
    for (const c of cases) {
      t.ai.calls.length = 0;
      const model = c.provider === "gemini" ? "gem-a" : "model-a";
      const res = await t.api("POST", "/api/settings/ai/test", { provider: c.provider, model, apiKey: c.provider === "local" ? undefined : "KEY", baseUrl: "baseUrl" in c ? c.baseUrl : undefined });
      expect(res.body, c.provider).toEqual({ ok: true, message: `${model} answered correctly.` });
      const call = t.ai.calls[0];
      expect(call.url, c.provider).toBe(c.url);
      if (c.header) expect(call.headers[c.header[0]], c.provider).toBe(c.header[1]);
      else expect(call.headers.authorization).toBeUndefined();
      if (c.provider === "anthropic") expect(call.body).toMatchObject({ model, system: expect.any(String), messages: [{ role: "user" }] });
      else if (c.provider === "gemini") expect(call.body).toMatchObject({ systemInstruction: { parts: [{}] }, generationConfig: { responseMimeType: "application/json" } });
      else expect(call.body).toMatchObject({ model, messages: [{ role: "system" }, { role: "user" }] });
    }
  });

  it("test uses the saved key when the box is left blank, and explains failures", async () => {
    t.ai.respond = fake;
    expect((await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" })).body.error).toMatch(/API key/);
    await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "m", apiKey: "SAVED" });
    await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" });
    expect(t.ai.calls.at(-1)!.headers.authorization).toBe("Bearer SAVED");
    t.ai.respond = () => ({ status: 401, json: { error: { message: "Incorrect API key provided" } } });
    expect((await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" })).body.error).toMatch(/didn't accept the API key: Incorrect/);
    t.ai.respond = () => ({ status: 404, json: { error: { message: "model not found" } } });
    expect((await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" })).body.error).toMatch(/Check the model name/);
    t.ai.respond = () => ({ status: 200, json: { choices: [{ message: { content: "Sure! Here you go." } }] } });
    expect((await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" })).body.error).toMatch(/not with the expected JSON/);
    t.ai.down = true;
    expect((await t.api("POST", "/api/settings/ai/test", { provider: "openai", model: "m" })).body.error).toMatch(/Couldn't reach/);
  });

  it("lists models for the picker", async () => {
    t.ai.respond = fake;
    // The form sends enabled: true and no model yet: listing must still work
    expect((await t.api("POST", "/api/settings/ai/models", { enabled: true, provider: "openai", apiKey: "K", model: "" })).body.models).toEqual(["model-a", "model-b"]);
    expect((await t.api("POST", "/api/settings/ai/test", { enabled: true, provider: "openai", apiKey: "K", model: "" })).body.error).toBe("Choose a model first");
    expect((await t.api("POST", "/api/settings/ai/models", { provider: "openai", apiKey: "K" })).body.models).toEqual(["model-a", "model-b"]);
    expect(t.ai.calls.at(-1)).toMatchObject({ method: "GET", url: "https://api.openai.com/v1/models" });
    expect((await t.api("POST", "/api/settings/ai/models", { provider: "gemini", apiKey: "K" })).body.models).toEqual(["gem-a", "gem-b"]);
    expect((await t.api("POST", "/api/settings/ai/models", { provider: "local", baseUrl: "http://10.0.0.5:11434/v1" })).body.models).toEqual(["llama-local", "qwen-local"]);
    expect((await t.api("POST", "/api/settings/ai/models", { provider: "local" })).body.error).toMatch(/address/);
  });

  it("parses JSON wrapped in fences or prose", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here: {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(parseJsonReply('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseJsonReply("nope")).toBeNull();
  });

  it("can be removed", async () => {
    await t.api("PUT", "/api/settings/ai", { ...base, provider: "openai", model: "m", apiKey: "k" });
    expect((await t.api("DELETE", "/api/settings/ai")).status).toBe(204);
    expect((await t.api("GET", "/api/settings/ai")).body).toEqual({ settings: null });
  });
});
