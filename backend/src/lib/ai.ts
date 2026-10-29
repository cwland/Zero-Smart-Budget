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

// One AI service in the list (tried in order: the first, then the next if it's down)
export interface StoredService {
  id: string;
  name: string; // "Home AI", "OpenAI backup" ...
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string | null; // local (required) or an override
  apiKeyEnc: string | null;
}

export interface StoredAi {
  enabled: boolean;
  mode: "auto" | "manual"; // auto: ask after bank syncs and new transactions; manual: only on "Ask AI"
  maxPerRun: number; // most transactions sent in one go (keeps costs predictable)
  timeoutSec: number; // give up on a service after this long and try the next one
  askNextOnNoMatch: boolean; // when one service finds no good fit, ask the next one too
  services: StoredService[];
}

// Settings saved before backup services existed: one provider at the top level
interface LegacyAi {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  mode: "auto" | "manual";
  maxPerRun: number;
}

export interface AiConfig {
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}
export type ActiveService = AiConfig & { id: string; name: string };

export const PROVIDER_NAMES: Record<AiProvider, string> = { openai: "OpenAI", anthropic: "Claude", gemini: "Gemini", openrouter: "OpenRouter", local: "Home AI" };

export interface ServiceInput {
  id?: string;
  name?: string;
  enabled?: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
  apiKey?: string | null; // undefined = keep the saved one, "" or null = remove it
}
export interface SaveInput {
  enabled?: boolean; // left out: keep the saved choice
  mode?: StoredAi["mode"];
  maxPerRun: number;
  timeoutSec?: number;
  askNextOnNoMatch?: boolean;
  services: ServiceInput[];
}

// Tests swap in a fake
export type AiFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class AiError extends Error {}

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const newId = () => Math.random().toString(36).slice(2, 10);

// Every saved service is used: AI is turned on and off only in Settings > Budget. Services saved
// back when each had its own switch are all used now; if every one was switched off, AI was
// effectively off, so it stays off.
function normalize(v: StoredAi | LegacyAi): StoredAi {
  if ("services" in v && Array.isArray(v.services)) {
    const allOff = v.services.length > 0 && v.services.every((sv) => sv.enabled === false);
    return {
      ...v,
      enabled: v.enabled && !allOff,
      timeoutSec: v.timeoutSec ?? 15,
      askNextOnNoMatch: v.askNextOnNoMatch ?? false,
      services: v.services.map((sv) => ({ ...sv, enabled: true })),
    };
  }
  const l = v as LegacyAi;
  return {
    enabled: l.enabled,
    mode: l.mode,
    maxPerRun: l.maxPerRun,
    timeoutSec: 15,
    askNextOnNoMatch: false,
    services: [{ id: "first", name: PROVIDER_NAMES[l.provider] ?? "AI", enabled: true, provider: l.provider, model: l.model, baseUrl: l.baseUrl, apiKeyEnc: l.apiKeyEnc }],
  };
}

export class AiService {
  constructor(
    private db: Db,
    private secret: string,
    private fetchImpl: AiFetch = fetch as unknown as AiFetch
  ) {}

  async stored(): Promise<StoredAi | null> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "ai"));
    return row?.value ? normalize(row.value as StoredAi | LegacyAi) : null;
  }

  async save(input: SaveInput) {
    const current = await this.stored();
    const services: StoredService[] = input.services.map((sv) => {
      const prev = sv.id ? current?.services.find((c) => c.id === sv.id) : undefined;
      const apiKeyEnc = sv.apiKey === undefined ? prev?.apiKeyEnc ?? null : sv.apiKey ? encryptSecret(sv.apiKey, this.secret) : null;
      return {
        id: prev?.id ?? sv.id ?? newId(),
        name: sv.name?.trim() || PROVIDER_NAMES[sv.provider],
        enabled: true, // always used (no per-service switch)
        provider: sv.provider,
        model: sv.model,
        baseUrl: sv.baseUrl,
        apiKeyEnc,
      };
    });
    const value: StoredAi = {
      enabled: input.enabled ?? current?.enabled ?? false,
      mode: input.mode ?? current?.mode ?? "auto",
      maxPerRun: input.maxPerRun,
      timeoutSec: input.timeoutSec ?? current?.timeoutSec ?? 15,
      askNextOnNoMatch: input.askNextOnNoMatch ?? current?.askNextOnNoMatch ?? false,
      services,
    };
    await this.db
      .insert(appSettings)
      .values({ key: "ai", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async clear() {
    await this.db.delete(appSettings).where(eq(appSettings.key, "ai"));
  }

  // A saved service's key (the first service when no id is given)
  async savedKey(id?: string) {
    const s = await this.stored();
    const sv = id ? s?.services.find((x) => x.id === id) : s?.services[0];
    if (!sv?.apiKeyEnc) return { key: null, unreadable: false };
    const key = decryptSecret(sv.apiKeyEnc, this.secret);
    return { key, unreadable: key === null };
  }

  // What the Settings page shows (keys included, for the eye button; signed-in page only).
  // The first service is also repeated at the top level (older screens read it there).
  async summary() {
    const s = await this.stored();
    if (!s) return null;
    const services = s.services.map(({ apiKeyEnc, ...sv }) => {
      const key = apiKeyEnc ? decryptSecret(apiKeyEnc, this.secret) : null;
      return { ...sv, apiKey: key, apiKeyUnreadable: !!apiKeyEnc && key === null };
    });
    const first = services[0];
    // At least one complete service: AI can be turned on in Settings > Budget
    const ready = s.services.some((sv) => sv.model && (sv.provider !== "local" || sv.baseUrl));
    return {
      ready,
      enabled: s.enabled,
      mode: s.mode,
      maxPerRun: s.maxPerRun,
      timeoutSec: s.timeoutSec,
      askNextOnNoMatch: s.askNextOnNoMatch,
      services,
      provider: first?.provider ?? null,
      model: first?.model ?? "",
      baseUrl: first?.baseUrl ?? null,
      apiKey: first?.apiKey ?? null,
      apiKeyUnreadable: first?.apiKeyUnreadable ?? false,
    };
  }

  // What's in use, or null when AI is off or no service is ready. Services in their order.
  async active(): Promise<{ mode: StoredAi["mode"]; maxPerRun: number; timeoutSec: number; askNextOnNoMatch: boolean; services: ActiveService[] } | null> {
    const s = await this.stored();
    if (!s?.enabled) return null;
    const services = s.services
      .filter((sv) => sv.model && (sv.provider !== "local" || sv.baseUrl))
      .map((sv) => ({ id: sv.id, name: sv.name, provider: sv.provider, model: sv.model, baseUrl: sv.baseUrl, apiKey: sv.apiKeyEnc ? decryptSecret(sv.apiKeyEnc, this.secret) : null }));
    if (!services.length) return null;
    return { mode: s.mode, maxPerRun: s.maxPerRun, timeoutSec: s.timeoutSec, askNextOnNoMatch: s.askNextOnNoMatch, services };
  }

  /**
   * Try the services in order until one answers. A service that can't be reached, times out, or
   * returns an error is skipped. Throws only when every one failed.
   */
  async chatWithFailover(services: ActiveService[], system: string, user: string, maxTokens: number, timeoutMs: number) {
    const failures: string[] = [];
    for (const [index, sv] of services.entries()) {
      try {
        const text = await this.chat(sv, system, user, maxTokens, timeoutMs);
        return { text, service: sv, index, failures };
      } catch (e) {
        if (!(e instanceof AiError) && !(e instanceof HttpError)) throw e;
        failures.push(`${sv.name}: ${(e as Error).message}`);
      }
    }
    throw new AiError(services.length === 1 ? failures[0].slice(services[0].name.length + 2) : `None of your AI services answered. ${failures.join(" ")}`);
  }

  private base(c: AiConfig) {
    const b = c.baseUrl?.trim() || DEFAULT_BASE[c.provider];
    if (!b) throw new HttpError(400, "Enter the address of your AI server (for example http://192.168.1.20:11434/v1)");
    return trimSlash(b);
  }

  private async request(url: string, headers: Record<string, string>, body?: unknown, method = "POST", timeoutMs = 60000) {
    let res;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new AiError(`The AI service didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
      });
      res = await Promise.race([
        this.fetchImpl(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: abort.signal }),
        timedOut,
      ]);
    } catch (e) {
      if (e instanceof AiError) throw e;
      throw new AiError(`Couldn't reach the AI service (${(e as Error).message}).`);
    } finally {
      clearTimeout(timer);
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
        return { authorization: `Bearer ${c.apiKey ?? ""}`, "x-title": "Zero Smart Budget" };
      default:
        return c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {};
    }
  }

  // Send one prompt, get the reply text. Asks for JSON where the provider supports it.
  async chat(c: AiConfig, system: string, user: string, maxTokens = 2000, timeoutMs = 60000): Promise<string> {
    if (c.provider !== "local" && !c.apiKey) throw new HttpError(400, "Enter an API key first");
    if (!c.model) throw new HttpError(400, "Choose a model first");
    const base = this.base(c);
    const headers = this.authHeaders(c);

    if (c.provider === "anthropic") {
      const r = await this.request(`${base}/messages`, headers, { model: c.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }, "POST", timeoutMs);
      return (r.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    }
    if (c.provider === "gemini") {
      const r = await this.request(`${base}/models/${encodeURIComponent(c.model.replace(/^models\//, ""))}:generateContent`, headers, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      }, "POST", timeoutMs);
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
    }, "POST", timeoutMs);
    return r.choices?.[0]?.message?.content ?? "";
  }

  // Model names the provider offers (for the picker)
  async models(c: AiConfig): Promise<string[]> {
    if (c.provider !== "local" && !c.apiKey) throw new HttpError(400, "Enter an API key first");
    const base = this.base(c);
    const r = await this.request(c.provider === "gemini" ? `${base}/models?pageSize=200` : `${base}/models`, this.authHeaders(c), undefined, "GET", 20000);
    const list: string[] =
      c.provider === "gemini"
        ? (r.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent")).map((m: any) => String(m.name).replace(/^models\//, ""))
        : (r.data ?? r.models ?? []).map((m: any) => String(m.id ?? m.name ?? m.model ?? ""));
    return [...new Set(list.filter(Boolean))].sort();
  }

  // A tiny round trip to prove the key, address and model work
  async test(c: AiConfig, timeoutMs = 60000) {
    const text = await this.chat(c, "You reply with JSON only.", 'Reply with exactly this JSON: {"ok": true}', 50, timeoutMs);
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
