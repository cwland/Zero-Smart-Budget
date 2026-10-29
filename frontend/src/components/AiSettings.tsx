import { useEffect, useState, type FormEvent } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ApiError, api } from "../api";
import { Card, Notice, field, primaryButton, secondaryButton } from "./settingsUi";
import { EyeIcon, EyeOffIcon, GripIcon } from "./Icons";

// AI suggestions with backup services: the list is tried top to bottom. If the first is down
// (can't connect, times out, or errors), the next one is asked instead. Optionally, whatever one
// service can't place is passed on to the next for another look.

type Provider = "openai" | "anthropic" | "gemini" | "openrouter" | "local";

interface SavedService {
  id: string;
  name: string;
  enabled: boolean;
  provider: Provider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  apiKeyUnreadable: boolean;
}
interface Saved {
  enabled: boolean;
  mode: "auto" | "manual";
  maxPerRun: number;
  timeoutSec: number;
  askNextOnNoMatch: boolean;
  services: SavedService[];
}

// A service as edited on screen (key: a local id for drag and drop)
interface Draft {
  key: string;
  id?: string;
  name: string;
  enabled: boolean;
  provider: Provider;
  model: string;
  baseUrl: string;
  apiKey: string;
  unreadable: boolean;
  models: string[];
  status: { ok: boolean; text: string } | null;
  busy: "" | "test" | "models";
}

const PROVIDERS: { id: Provider; label: string; name: string; hint: string; keyUrl?: string }[] = [
  { id: "local", label: "Local / OpenAI-compatible", name: "Home AI", hint: "Ollama, LM Studio, LocalAI, vLLM… on your own network. Nothing leaves your network." },
  { id: "openai", label: "OpenAI", name: "OpenAI", hint: "API key from platform.openai.com", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic (Claude)", name: "Claude", hint: "API key from console.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini", name: "Gemini", hint: "API key from Google AI Studio", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", hint: "One key for many models, from openrouter.ai", keyUrl: "https://openrouter.ai/settings/keys" },
];

let nextKey = 1;
const toDraft = (s: SavedService): Draft => ({
  key: `k${nextKey++}`,
  id: s.id,
  name: s.name,
  enabled: s.enabled,
  provider: s.provider,
  model: s.model,
  baseUrl: s.baseUrl ?? "",
  apiKey: s.apiKey ?? "",
  unreadable: s.apiKeyUnreadable,
  models: [],
  status: null,
  busy: "",
});
const blank = (provider: Provider = "local"): Draft => ({
  key: `k${nextKey++}`,
  name: PROVIDERS.find((p) => p.id === provider)!.name,
  enabled: true,
  provider,
  model: "",
  baseUrl: "",
  apiKey: "",
  unreadable: false,
  models: [],
  status: null,
  busy: "",
});

// The fields one service needs, to save, test or list models
const serviceBody = (d: Draft) => ({ id: d.id, name: d.name.trim(), enabled: d.enabled, provider: d.provider, model: d.model.trim(), baseUrl: d.baseUrl.trim() || null, apiKey: d.apiKey.trim() });

function ServiceCard({ d, index, count, onChange, onRemove, onMove }: { d: Draft; index: number; count: number; onChange: (c: Partial<Draft>) => void; onRemove: () => void; onMove: (to: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: d.key });
  const [showKey, setShowKey] = useState(false);
  const info = PROVIDERS.find((p) => p.id === d.provider)!;
  const listId = `ai-models-${d.key}`;

  async function call(kind: "test" | "models") {
    onChange({ busy: kind, status: null });
    try {
      if (kind === "test") {
        const r = await api<{ message: string }>("POST", "/api/settings/ai/test", serviceBody(d));
        onChange({ busy: "", status: { ok: true, text: r.message } });
      } else {
        const r = await api<{ models: string[] }>("POST", "/api/settings/ai/models", serviceBody(d));
        onChange({ busy: "", models: r.models, status: { ok: true, text: r.models.length ? `${r.models.length} models found. Pick one from the Model box.` : "No models found." } });
      }
    } catch (e) {
      const text = e instanceof ApiError && e.details?.length ? e.details.map((x) => x.message).join(". ") : (e as Error).message;
      onChange({ busy: "", status: { ok: false, text } });
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`AI service ${index + 1}: ${d.name}`}
      className={`relative rounded-xl border bg-white p-4 pl-8 ${isDragging ? "z-10 border-action shadow-[0_12px_32px_rgba(31,36,38,0.18)]" : "border-line"} ${d.enabled ? "" : "opacity-70"}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${d.name}`}
        className="absolute left-1.5 top-4 flex h-8 w-5 cursor-grab touch-none items-center justify-center text-muted hover:text-ink active:cursor-grabbing"
      >
        <GripIcon />
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white" title={index === 0 ? "Tried first" : `Backup #${index}`}>
          {index + 1}
        </span>
        <input aria-label="Service name" value={d.name} onChange={(e) => onChange({ name: e.target.value })} className="min-w-0 flex-1 rounded border border-transparent px-1 py-1 text-lg font-semibold hover:border-line focus:border-action focus:outline-none" />
        <span className="text-sm text-subtle">{index === 0 ? "Tried first" : "Backup"}</span>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={d.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="size-4" />
          On
        </label>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="text-sm font-medium text-subtle">
          Provider
          <select
            aria-label="Provider"
            value={d.provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              const renamed = PROVIDERS.some((x) => x.name === d.name) ? PROVIDERS.find((x) => x.id === p)!.name : d.name;
              onChange({ provider: p, models: [], name: renamed });
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

        {d.provider === "local" && (
          <label className="text-sm font-medium text-subtle">
            Server address
            <input aria-label="Server address" placeholder="http://192.168.1.20:11434/v1" value={d.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} className={field} />
          </label>
        )}

        <label className="block text-sm font-medium text-subtle">
          API key {d.provider === "local" && <span className="font-normal">(optional)</span>}
          <span className="relative mt-1 block">
            <input
              aria-label="API key"
              type="text"
              style={showKey ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
              autoComplete="off"
              spellCheck={false}
              placeholder={d.provider === "local" ? "Only if your server needs one" : "Paste your API key"}
              value={d.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              className={field + " !mt-0 pr-11 font-mono"}
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-subtle hover:text-ink">
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </span>
          {d.unreadable && <span className="mt-1 block text-error">The saved key can't be read (JWT_SECRET changed). Paste it again.</span>}
        </label>

        <label className="text-sm font-medium text-subtle">
          Model
          <span className="mt-1 flex gap-2">
            <input aria-label="Model" list={listId} placeholder="Type a model name, or click Load models" value={d.model} onChange={(e) => onChange({ model: e.target.value })} className={field + " !mt-0 flex-1 font-mono"} />
            <button type="button" onClick={() => call("models")} disabled={!!d.busy} className={secondaryButton + " shrink-0 !py-2"}>
              {d.busy === "models" ? "Loading…" : "Load models"}
            </button>
          </span>
          <datalist id={listId}>
            {d.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => call("test")} disabled={!!d.busy} className={secondaryButton + " !py-2"}>
            {d.busy === "test" ? "Testing…" : "Test"}
          </button>
          <span className="flex gap-1">
            <button type="button" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Move ${d.name} up`} className="rounded px-2 py-1 text-subtle hover:bg-page disabled:opacity-30">
              ↑
            </button>
            <button type="button" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Move ${d.name} down`} className="rounded px-2 py-1 text-subtle hover:bg-page disabled:opacity-30">
              ↓
            </button>
          </span>
          <button type="button" onClick={onRemove} className="ml-auto text-sm text-error hover:underline">
            Remove
          </button>
        </div>
        <Notice msg={d.status} />
      </div>
    </li>
  );
}

export default function AiSettings() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [maxPerRun, setMaxPerRun] = useState("50");
  const [timeoutSec, setTimeoutSec] = useState("15");
  const [askNext, setAskNext] = useState(false);
  const [services, setServices] = useState<Draft[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "remove">("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  function apply(s: Saved | null) {
    setSaved(s);
    setEnabled(s?.enabled ?? true);
    setMode(s?.mode ?? "auto");
    setMaxPerRun(String(s?.maxPerRun ?? 50));
    setTimeoutSec(String(s?.timeoutSec ?? 15));
    setAskNext(s?.askNextOnNoMatch ?? false);
    setServices(s?.services.length ? s.services.map(toDraft) : [blank()]);
  }

  useEffect(() => {
    api<{ settings: Saved | null }>("GET", "/api/settings/ai")
      .then((r) => apply(r.settings))
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }))
      .finally(() => setLoaded(true));
  }, []);

  const change = (key: string, c: Partial<Draft>) => setServices((list) => list.map((d) => (d.key === key ? { ...d, ...c } : d)));
  const move = (from: number, to: number) => setServices((list) => arrayMove(list, from, to));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = services.findIndex((d) => d.key === active.id);
    const to = services.findIndex((d) => d.key === over.id);
    move(from, to);
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy("save");
    api<{ settings: Saved }>("PUT", "/api/settings/ai", {
      enabled,
      mode,
      maxPerRun: Number(maxPerRun) || 50,
      timeoutSec: Number(timeoutSec) || 15,
      askNextOnNoMatch: askNext,
      services: services.map(serviceBody),
    })
      .then((r) => {
        apply(r.settings);
        setMsg({ ok: true, text: "Saved" });
      })
      .catch((err) => setMsg({ ok: false, text: err instanceof ApiError && err.details?.length ? err.details.map((d) => d.message).join(". ") : (err as Error).message }))
      .finally(() => setBusy(""));
  };

  const remove = () => {
    setBusy("remove");
    api("DELETE", "/api/settings/ai")
      .then(() => {
        apply(null);
        setConfirmRemove(false);
        setMsg({ ok: true, text: "AI settings removed" });
      })
      .catch((err) => setMsg({ ok: false, text: (err as Error).message }))
      .finally(() => setBusy(""));
  };

  if (!loaded) return null;

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

        <section aria-label="AI services">
          <h3 className="font-semibold">AI services</h3>
          <p className="mt-1 text-sm text-subtle">Tried from the top. If one is down or doesn't answer in time, the next one is asked. Drag ⠿ (or use the arrows) to change the order.</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={services.map((d) => d.key)} strategy={verticalListSortingStrategy}>
              <ol className="mt-3 flex flex-col gap-3">
                {services.map((d, i) => (
                  <ServiceCard
                    key={d.key}
                    d={d}
                    index={i}
                    count={services.length}
                    onChange={(c) => change(d.key, c)}
                    onRemove={() => setServices((list) => list.filter((x) => x.key !== d.key))}
                    onMove={(to) => move(i, to)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {services.length < 10 && (
            <button type="button" onClick={() => setServices((list) => [...list, blank(list.length ? "openrouter" : "local")])} className="mt-3 font-semibold text-action hover:underline">
              + Add {services.length ? "a backup AI service" : "an AI service"}
            </button>
          )}
        </section>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
          <input type="checkbox" checked={askNext} onChange={(e) => setAskNext(e.target.checked)} className="mt-1 size-4" />
          <span>
            <span className="block font-semibold">Ask the next AI when one finds no good fit</span>
            <span className="block text-sm text-subtle">Transactions the first AI can't place are sent to the next one for another look (for example, your home AI first, then a bigger cloud model).</span>
          </span>
        </label>

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

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-subtle">
            Give up on a service after
            <span className="mt-1 flex items-center gap-2">
              <input aria-label="Seconds to wait" type="number" min={3} max={300} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} className={field + " !mt-0 max-w-[6rem]"} />
              seconds
            </span>
            <span className="mt-1 block font-normal">Then the next one is asked.</span>
          </label>
          <label className="text-sm font-medium text-subtle">
            Most transactions per run
            <input aria-label="Most transactions per run" type="number" min={1} max={500} value={maxPerRun} onChange={(e) => setMaxPerRun(e.target.value)} className={field + " block max-w-[8rem]"} />
            <span className="mt-1 block font-normal">Keeps costs predictable.</span>
          </label>
        </div>

        <p className="rounded-lg bg-page px-3 py-2 text-sm text-subtle">
          Sent to the AI: merchant, amount, date, money in or out, account name, and your budget item names for that month. Never passwords or account numbers. Transactions that already have a suggestion from your history are never sent.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!!busy} className={primaryButton}>
            {busy === "save" ? "Saving…" : "Save"}
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
                Remove all
              </button>
            ))}
        </div>
        <Notice msg={msg} />
      </form>
    </Card>
  );
}
