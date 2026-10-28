import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { Card, Notice, field, primaryButton, secondaryButton } from "./settingsUi";
import { EyeIcon, EyeOffIcon } from "./Icons";

type Provider = "openai" | "anthropic" | "gemini" | "openrouter" | "local";

interface Saved {
  enabled: boolean;
  provider: Provider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  apiKeyUnreadable: boolean;
  mode: "auto" | "manual";
  maxPerRun: number;
}

const PROVIDERS: { id: Provider; label: string; hint: string; keyUrl?: string }[] = [
  { id: "openai", label: "OpenAI", hint: "API key from platform.openai.com", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic (Claude)", hint: "API key from console.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini", hint: "API key from Google AI Studio", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", hint: "One key for many models, from openrouter.ai", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "local", label: "Local / OpenAI-compatible", hint: "Ollama, LM Studio, LocalAI, vLLM… on your own network. Nothing leaves your network." },
];

export default function AiSettings() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [maxPerRun, setMaxPerRun] = useState("50");
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "save" | "test" | "models" | "remove">("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  function apply(s: Saved | null) {
    setSaved(s);
    setEnabled(s?.enabled ?? true);
    setProvider(s?.provider ?? "openai");
    setModel(s?.model ?? "");
    setBaseUrl(s?.baseUrl ?? "");
    setApiKey(s?.apiKey ?? "");
    setMode(s?.mode ?? "auto");
    setMaxPerRun(String(s?.maxPerRun ?? 50));
    setShowKey(false);
  }

  useEffect(() => {
    api<{ settings: Saved | null }>("GET", "/api/settings/ai")
      .then((r) => apply(r.settings))
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }))
      .finally(() => setLoaded(true));
  }, []);

  const info = PROVIDERS.find((p) => p.id === provider)!;
  const body = () => ({ enabled, provider, model: model.trim(), baseUrl: baseUrl.trim() || null, apiKey: apiKey.trim(), mode, maxPerRun: Number(maxPerRun) || 50 });

  async function run(kind: typeof busy, fn: () => Promise<void>) {
    setMsg(null);
    setFieldErrors({});
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setFieldErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      setMsg({ ok: false, text: e instanceof ApiError && e.details?.length ? e.details.map((d) => d.message).join(". ") : (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("save", async () => {
      const r = await api<{ settings: Saved }>("PUT", "/api/settings/ai", body());
      apply(r.settings);
      setMsg({ ok: true, text: "Saved" });
    });
  };
  const test = () =>
    run("test", async () => {
      const r = await api<{ message: string }>("POST", "/api/settings/ai/test", body());
      setMsg({ ok: true, text: r.message });
    });
  const loadModels = () =>
    run("models", async () => {
      const r = await api<{ models: string[] }>("POST", "/api/settings/ai/models", body());
      setModels(r.models);
      setMsg({ ok: true, text: r.models.length ? `${r.models.length} models found. Pick one from the Model box.` : "No models found." });
    });
  const remove = () =>
    run("remove", async () => {
      await api("DELETE", "/api/settings/ai");
      apply(null);
      setModels([]);
      setConfirmRemove(false);
      setMsg({ ok: true, text: "AI settings removed" });
    });

  if (!loaded) return null;
  const err = (k: string) => (fieldErrors[k] ? " border-error" : "");

  return (
    <Card
      title="AI suggestions"
      description="When a transaction has no history to learn from, AI can suggest a budget item. It never assigns anything itself: suggestions show as purple ✦ chips you accept or ignore."
    >
      <form onSubmit={save} className="flex flex-col gap-5">
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4" />
          <span className="font-semibold">Use AI for suggestions</span>
        </label>

        <label className="text-sm font-medium text-subtle">
          Provider
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setModels([]);
            }}
            className={field}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal">
            {info.hint}
            {info.keyUrl && (
              <>
                {" · "}
                <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-action hover:underline">
                  Get a key
                </a>
              </>
            )}
          </span>
        </label>

        {provider === "local" && (
          <label className="text-sm font-medium text-subtle">
            Server address
            <input
              aria-label="Server address"
              placeholder="http://192.168.1.20:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className={field + err("baseUrl")}
            />
            <span className="mt-1 block font-normal">The OpenAI-compatible address, usually ending in /v1. For Ollama: http://&lt;computer&gt;:11434/v1</span>
          </label>
        )}

        <label className="block text-sm font-medium text-subtle">
          API key {provider === "local" && <span className="font-normal">(optional)</span>}
          <span className="relative mt-1 block">
            <input
              aria-label="API key"
              type="text"
              style={showKey ? undefined : { WebkitTextSecurity: "disc" } as React.CSSProperties} // dots without being a password box
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === "local" ? "Only if your server needs one" : "Paste your API key"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={field + " !mt-0 pr-11 font-mono"}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              aria-pressed={showKey}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-subtle hover:text-ink"
            >
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </span>
          {saved?.apiKeyUnreadable && <span className="mt-1 block text-error">The saved key can't be read (JWT_SECRET changed). Paste it again.</span>}
        </label>

        <div>
          <label className="text-sm font-medium text-subtle">
            Model
            <span className="mt-1 flex gap-2">
              <input
                aria-label="Model"
                list="ai-models"
                placeholder="Type a model name, or click Load models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={field + " !mt-0 flex-1 font-mono" + err("model")}
              />
              <button type="button" onClick={loadModels} disabled={!!busy} className={secondaryButton + " shrink-0 !py-2"}>
                {busy === "models" ? "Loading…" : "Load models"}
              </button>
            </span>
          </label>
          <datalist id="ai-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="mt-1 text-sm text-subtle">A small, inexpensive model is plenty for picking a budget item.</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-subtle">When to ask the AI</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(
              [
                ["auto", "Automatically", "After each bank sync and when you add a transaction"],
                ["manual", "Only when I ask", "Nothing is sent until you click Ask AI"],
              ] as const
            ).map(([id, label, hint]) => (
              <label key={id} className={`cursor-pointer rounded-lg border p-3 ${mode === id ? "border-action bg-pressed" : "border-line hover:bg-page"}`}>
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="ai-mode" checked={mode === id} onChange={() => setMode(id)} />
                  {label}
                </span>
                <span className="mt-1 block text-sm text-subtle">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="text-sm font-medium text-subtle">
          Most transactions per run
          <input aria-label="Most transactions per run" type="number" min={1} max={500} value={maxPerRun} onChange={(e) => setMaxPerRun(e.target.value)} className={field + " block max-w-[8rem]"} />
          <span className="mt-1 block font-normal">Keeps costs predictable. Anything over this waits for the next run.</span>
        </label>

        <p className="rounded-lg bg-page px-3 py-2 text-sm text-subtle">
          Sent to the AI: merchant, amount, date, money in or out, account name, and your budget item names for that month. Never passwords or account numbers.
          Transactions that already have a suggestion from your history are never sent.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!!busy} className={primaryButton}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={test} disabled={!!busy} className={secondaryButton}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          {saved &&
            (confirmRemove ? (
              <span className="flex items-center gap-2">
                <button type="button" onClick={remove} disabled={!!busy} className="rounded bg-error px-3 py-2 font-semibold text-white">
                  Remove AI settings
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} className="px-2 text-subtle hover:underline">
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} className="ml-auto text-error hover:underline">
                Remove
              </button>
            ))}
        </div>
        <Notice msg={msg} />
      </form>
    </Card>
  );
}
