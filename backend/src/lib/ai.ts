import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { HttpError } from "./errors.js";

// AI suggestions for transactions that have no history to learn from. Settings live in
// app_settings under "ai" (the API key encrypted). Five kinds of provider:
//  - openai, openrouter, local: the OpenAI chat-completions format (local = Ollama, LM Studio,
//    LocalAI, vLLM ... at a base URL you give, key optional)
//  - anthropic: Claude's Messages API
//  - gemini: Google's generateContent API

export const AI_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "local"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

const DEFAULT_BASE: Record<AiProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  local: "",
};

export interface StoredAi {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string | null; // local (required) or an override
  apiKeyEnc: string | null;
  mode: "auto" | "manual"; // auto: ask after bank syncs and new transactions; manual: only on "Ask AI"
  maxPerRun: number; // most transactions sent in one go (keeps costs predictable)
}

export interface AiConfig {
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

// Tests swap in a fake
export type AiFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class AiError extends Error {}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export class AiService {
  constructor(
    private db: Db,
    private secret: string,
    private fetchImpl: AiFetch = fetch as unknown as AiFetch
  ) {}

  async stored(): Promise<StoredAi | null> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "ai"));
    return (row?.value as StoredAi) ?? null;
  }

  // apiKey: undefined = keep the saved one, "" or null = remove it
  async save(input: Omit<StoredAi, "apiKeyEnc"> & { apiKey?: string | null }) {
    const current = await this.stored();
    const { apiKey, ...rest } = input;
    const apiKeyEnc = apiKey === undefined ? current?.apiKeyEnc ?? null : apiKey ? encryptSecret(apiKey, this.secret) : null;
    const value: StoredAi = { ...rest, apiKeyEnc };
    await this.db
      .insert(appSettings)
      .values({ key: "ai", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async clear() {
    await this.db.delete(appSettings).where(eq(appSettings.key, "ai"));
  }

  async savedKey() {
    const s = await this.stored();
    if (!s?.apiKeyEnc) return { key: null, unreadable: false };
    const key = decryptSecret(s.apiKeyEnc, this.secret);
    return { key, unreadable: key === null };
  }

  // What the Settings page shows (the key included, for the eye button; signed-in page only)
  async summary() {
    const s = await this.stored();
    if (!s) return null;
    const { key, unreadable } = await this.savedKey();
    const { apiKeyEnc: _e, ...rest } = s;
    return { ...rest, apiKey: key, apiKeyUnreadable: unreadable };
  }

  // The config in use, or null when AI is off or not set up
  async active(): Promise<(AiConfig & { mode: StoredAi["mode"]; maxPerRun: number }) | null> {
    const s = await this.stored();
    if (!s?.enabled || !s.model) return null;
    const { key } = await this.savedKey();
    return { provider: s.provider, model: s.model, baseUrl: s.baseUrl, apiKey: key, mode: s.mode, maxPerRun: s.maxPerRun };
  }

  private base(c: AiConfig) {
    const b = c.baseUrl?.trim() || DEFAULT_BASE[c.provider];
    if (!b) throw new HttpError(400, "Enter the address of your AI server (for example http://192.168.1.20:11434/v1)");
    return trimSlash(b);
  }

  private async request(url: string, headers: Record<string, string>, body?: unknown, method = "POST") {
    let res;
    try {
      res = await this.fetchImpl(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new AiError(`Couldn't reach the AI service (${(e as Error).message}).`);
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? (typeof json?.error === "string" ? json.error : "") ?? "";
      if (res.status === 401 || res.status === 403) throw new AiError(`The AI service didn't accept the API key${msg ? `: ${msg}` : "."}`);
      if (res.status === 404) throw new AiError(`Not found. Check the model name and address${msg ? ` (${msg})` : ""}.`);
      if (res.status === 429) throw new AiError(`The AI service says too many requests or out of credit${msg ? `: ${msg}` : ""}.`);
      throw new AiError(`The AI service returned ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return json;
  }

  private authHeaders(c: AiConfig): Record<string, string> {
    switch (c.provider) {
      case "anthropic":
        return { "x-api-key": c.apiKey ?? "", "anthropic-version": "2023-06-01" };
      case "gemini":
        return { "x-goog-api-key": c.apiKey ?? "" };
      case "openrouter":
        return { authorization: `Bearer ${c.apiKey ?? ""}`, "x-title": "Cory's Dollar" };
      default:
        return c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {};
    }
  }

  // Send one prompt, get the reply text. Asks for JSON where the provider supports it.
  async chat(c: AiConfig, system: string, user: string, maxTokens = 2000): Promise<string> {
    if (c.provider !== "local" && !c.apiKey) throw new HttpError(400, "Enter an API key first");
    if (!c.model) throw new HttpError(400, "Choose a model first");
    const base = this.base(c);
    const headers = this.authHeaders(c);

    if (c.provider === "anthropic") {
      const r = await this.request(`${base}/messages`, headers, { model: c.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] });
      return (r.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    }
    if (c.provider === "gemini") {
      const r = await this.request(`${base}/models/${encodeURIComponent(c.model.replace(/^models\//, ""))}:generateContent`, headers, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      });
      return (r.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    }
    // OpenAI, OpenRouter and local servers share the chat-completions format
    const r = await this.request(`${base}/chat/completions`, headers, {
      model: c.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return r.choices?.[0]?.message?.content ?? "";
  }

  // Model names the provider offers (for the picker)
  async models(c: AiConfig): Promise<string[]> {
    if (c.provider !== "local" && !c.apiKey) throw new HttpError(400, "Enter an API key first");
    const base = this.base(c);
    const r = await this.request(c.provider === "gemini" ? `${base}/models?pageSize=200` : `${base}/models`, this.authHeaders(c), undefined, "GET");
    const list: string[] =
      c.provider === "gemini"
        ? (r.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent")).map((m: any) => String(m.name).replace(/^models\//, ""))
        : (r.data ?? r.models ?? []).map((m: any) => String(m.id ?? m.name ?? m.model ?? ""));
    return [...new Set(list.filter(Boolean))].sort();
  }

  // A tiny round trip to prove the key, address and model work
  async test(c: AiConfig) {
    const text = await this.chat(c, "You reply with JSON only.", 'Reply with exactly this JSON: {"ok": true}', 50);
    const parsed = parseJsonReply(text);
    if (!parsed || (parsed as any).ok !== true) throw new AiError(`The model answered, but not with the expected JSON. It said: ${text.slice(0, 120)}`);
  }
}

// Models often wrap JSON in ```json fences or add a sentence; pull out the JSON
export function parseJsonReply(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  for (const candidate of [cleaned, cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1), cleaned.slice(cleaned.indexOf("["), cleaned.lastIndexOf("]") + 1)]) {
    try {
      if (candidate) return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}
