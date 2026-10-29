import { useEffect, useState, type FormEvent } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ApiError, api } from "../api";
import { Card, Notice, field, primaryButton, secondaryButton } from "./settingsUi";
import { ChevronDown, ChevronRight, EyeIcon, EyeOffIcon, GripIcon } from "./Icons";
import { Popup } from "./Popup";
import { useUnsavedGuard } from "../unsavedGuard";

// Which saved services are collapsed (remembered in this browser)
const COLLAPSED_KEY = "zeropoint.aiCollapsed";
const readCollapsed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
};
const writeCollapsed = (ids: Set<string>) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // private window: just don't remember
  }
};

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
const serviceBody = (d: Draft) => ({ id: d.id, name: d.name.trim(), enabled: true, provider: d.provider, model: d.model.trim(), baseUrl: d.baseUrl.trim() || null, apiKey: d.apiKey.trim() });

function ServiceCard({ d, index, count, saving, dirty, failed, onSave, onChange, onRemove, onMove }: { d: Draft; index: number; count: number; saving: boolean; dirty: boolean; failed: boolean; onSave: (skipCheck?: boolean) => void; onChange: (c: Partial<Draft>) => void; onRemove: () => void; onMove: (to: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: d.key });
  const [showKey, setShowKey] = useState(false);
  // New (unsaved) services start open; saved ones open or closed as you left them
  const [collapsed, setCollapsedState] = useState(() => !!d.id && readCollapsed().has(d.id));
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    if (!d.id) return;
    const ids = readCollapsed();
    if (v) ids.add(d.id);
    else ids.delete(d.id);
    writeCollapsed(ids);
  };
  // A service that failed its check opens, so you can see why
  useEffect(() => {
    if (d.status && !d.status.ok) setCollapsedState(false);
  }, [d.status]);
  const info = PROVIDERS.find((p) => p.id === d.provider)!;
  const listId = `ai-models-${d.key}`;

  async function loadModels() {
    onChange({ busy: "models", status: null });
    try {
      const r = await api<{ models: string[] }>("POST", "/api/settings/ai/models", serviceBody(d));
      onChange({ busy: "", models: r.models, status: { ok: true, text: r.models.length ? `${r.models.length} models found. Pick one from the Model box.` : "No models found." } });
    } catch (e) {
      onChange({ busy: "", status: { ok: false, text: errorText(e) } });
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={`AI service ${index + 1}: ${d.name}`}
      className={`relative rounded-xl border bg-white p-4 pl-8 ${isDragging ? "z-10 border-action shadow-[0_12px_32px_rgba(31,36,38,0.18)]" : "border-line"} `}
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
      {/* Show / hide this service's settings (under the drag handle) */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${d.name} settings` : `Hide ${d.name} settings`}
        className="absolute left-1 top-12 flex size-6 items-center justify-center rounded text-subtle hover:bg-page hover:text-ink"
      >
        {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white" title={index === 0 ? "Asked first" : `Backup ${index}`}>
          {index + 1}
        </span>
        <input aria-label="Service name" value={d.name} onChange={(e) => onChange({ name: e.target.value })} className="min-w-0 flex-1 rounded border border-transparent px-1 py-1 text-lg font-semibold hover:border-line focus:border-action focus:outline-none" />
        {/* Its place in the list */}
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${index === 0 ? "bg-pressed text-primary" : "bg-page text-subtle"}`}>
          {index === 0 ? "Asked first" : `Backup ${index}`}
        </span>
      </div>
      {collapsed && (
        <p className="mt-1 truncate pl-9 text-sm text-subtle">
          {PROVIDERS.find((p) => p.id === d.provider)!.label}
          {d.model ? ` · ${d.model}` : " · no model yet"}
          {d.provider === "local" && d.baseUrl ? ` · ${d.baseUrl}` : ""}
        </p>
      )}
      {collapsed && d.status && (
        <div className="mt-2 pl-9">
          <Notice msg={d.status} />
        </div>
      )}

      {!collapsed && <div className="mt-3 grid gap-3">
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
            <button type="button" onClick={loadModels} disabled={!!d.busy} className={secondaryButton + " shrink-0 !py-2"}>
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
          {/* Checks this service, then saves it (only enabled once something on it changed) */}
          <button type="button" onClick={() => onSave()} disabled={!dirty || !!d.busy || saving} className={primaryButton + " !py-2"}>
            {d.busy === "test" ? "Checking…" : "Save"}
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
        {failed && (
          <button type="button" onClick={() => onSave(true)} disabled={saving} className="self-start text-sm font-semibold text-error hover:underline">
            Save anyway
          </button>
        )}
      </div>}
    </li>
  );
}

const errorText = (e: unknown) => (e instanceof ApiError && e.details?.length ? e.details.map((x) => x.message).join(". ") : (e as Error).message);

export default function AiSettings() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [maxPerRun, setMaxPerRun] = useState("50");
  const [timeoutSec, setTimeoutSec] = useState("15");
  const [askNext, setAskNext] = useState(false);
  const [services, setServices] = useState<Draft[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "remove" | "turn-on">("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [askTurnOn, setAskTurnOn] = useState(false); // after the first service is set up, offer to turn AI on
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  function apply(s: Saved | null) {
    setSaved(s);
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

  // ---- What's changed since the last save ----
  const savedById = new Map((saved?.services ?? []).map((sv) => [sv.id, sv]));
  const cardDirty = (d: Draft) => {
    const sv = d.id ? savedById.get(d.id) : undefined;
    if (!sv) return !!saved?.services.length || !!(d.model.trim() || d.baseUrl.trim() || d.apiKey.trim()) || d.provider !== "local"; // new (a first, untouched card isn't)
    return d.name.trim() !== sv.name || d.provider !== sv.provider || d.model.trim() !== sv.model || (d.baseUrl.trim() || null) !== (sv.baseUrl ?? null) || d.apiKey.trim() !== (sv.apiKey ?? "");
  };
  const savedIds = (saved?.services ?? []).map((sv) => sv.id);
  const currentIds = services.filter((d) => d.id).map((d) => d.id!);
  const listChanged = savedIds.join() !== currentIds.join(); // removed or reordered
  const optionsChanged = String(saved?.maxPerRun ?? 50) !== maxPerRun || String(saved?.timeoutSec ?? 15) !== timeoutSec || (saved?.askNextOnNoMatch ?? false) !== askNext;
  const anyDirty = services.some(cardDirty) || listChanged || optionsChanged;
  useUnsavedGuard("ai-settings", anyDirty, "AI settings");

  // Ask one service a short test question; shows the answer (or why not) on its card
  const check = async (d: Draft) => {
    change(d.key, { busy: "test", status: null });
    try {
      const r = await api<{ message: string }>("POST", "/api/settings/ai/test", serviceBody(d));
      change(d.key, { busy: "", status: { ok: true, text: r.message } });
      return null;
    } catch (err) {
      const text = errorText(err);
      change(d.key, { busy: "", status: { ok: false, text } });
      return text;
    }
  };
  const afterFirstSetup = (wasEmpty: boolean, r: Saved) => {
    if (wasEmpty && !r.enabled) setAskTurnOn(true);
  };
  const [failedCheck, setFailedCheck] = useState<"all" | string | null>(null); // which Save to offer "Save anyway" for

  // A card's Save: checks that service only, then saves just that one. Other cards keep any
  // edits you haven't saved yet.
  const saveOne = async (d: Draft, skipCheck = false) => {
    setMsg(null);
    setFailedCheck(null);
    setBusy("save");
    try {
      if (!skipCheck) {
        const failed = await check(d);
        if (failed) {
          change(d.key, { status: { ok: false, text: `Not saved: ${failed}` } });
          setFailedCheck(d.key);
          return;
        }
      }
      const wasEmpty = !saved?.services.length;
      const keep = (saved?.services ?? []).map((sv) => (sv.id === d.id ? serviceBody(d) : { id: sv.id, name: sv.name, enabled: true, provider: sv.provider, model: sv.model, baseUrl: sv.baseUrl }));
      const r = await api<{ settings: Saved }>("PUT", "/api/settings/ai", {
        maxPerRun: saved?.maxPerRun ?? 50,
        timeoutSec: saved?.timeoutSec ?? 15,
        askNextOnNoMatch: saved?.askNextOnNoMatch ?? false,
        services: d.id ? keep : [...keep, serviceBody(d)],
      });
      const newId = d.id ?? r.settings.services.find((sv) => !savedIds.includes(sv.id))?.id;
      const sv = r.settings.services.find((x) => x.id === newId);
      setSaved(r.settings);
      change(d.key, { id: newId, apiKey: sv?.apiKey ?? d.apiKey, status: { ok: true, text: skipCheck ? "Saved, even though it didn't answer. It's skipped until it answers again." : "Saved. It answered correctly." } });
      afterFirstSetup(wasEmpty, r.settings);
    } catch (err) {
      change(d.key, { status: { ok: false, text: errorText(err) } });
    } finally {
      setBusy("");
    }
  };

  // The bottom Save: everything on the page. Only services you changed are checked.
  const save = async (e?: FormEvent, skipCheck = false) => {
    e?.preventDefault();
    setMsg(null);
    setFailedCheck(null);
    setBusy("save");
    try {
      const changed = services.filter(cardDirty);
      if (!skipCheck && changed.length) {
        const failed: string[] = [];
        for (const d of changed) {
          const text = await check(d);
          if (text) failed.push(services.length > 1 ? `${d.name.trim() || "A service"}: ${text}` : text);
        }
        if (failed.length) {
          setMsg({ ok: false, text: `Not saved. ${changed.length > 1 ? `${failed.length} of the ${changed.length} services you changed didn't answer. ` : "The service you changed didn't answer. "}${failed.join(" ")}` });
          setFailedCheck("all");
          return;
        }
      }
      // On/off and how it's used are saved from Settings > Budget, so they're left alone here
      const r = await api<{ settings: Saved }>("PUT", "/api/settings/ai", {
        maxPerRun: Number(maxPerRun) || 50,
        timeoutSec: Number(timeoutSec) || 15,
        askNextOnNoMatch: askNext && enabledCount >= 2,
        services: services.map(serviceBody),
      });
      const wasEmpty = !saved?.services.length;
      apply(r.settings);
      setMsg({ ok: true, text: skipCheck ? "Saved, even though not every service answered. A service that's down is skipped until it answers again." : changed.length ? `Saved. ${changed.length > 1 ? "The services you changed answered." : "It answered correctly."}` : "Saved." });
      afterFirstSetup(wasEmpty, r.settings);
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy("");
    }
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

  const enabledCount = services.length;

  const turnOn = () => {
    setBusy("turn-on");
    api<{ settings: Saved }>("PUT", "/api/settings/ai/usage", { enabled: true })
      .then((r) => {
        setSaved((s) => (s ? { ...s, enabled: r.settings.enabled } : s));
        setMsg({ ok: true, text: "AI categorization is on. Change how it's used in Settings › Budget." });
        setAskTurnOn(false);
      })
      .catch((err) => setMsg({ ok: false, text: (err as Error).message }))
      .finally(() => setBusy(""));
  };
  if (!loaded) return null;

  return (
    <Card
      title="AI services"
      description="The AI services used for suggestions when a transaction has no history to learn from. Suggestions show as purple ✦ chips you accept or ignore; nothing is assigned on its own."
    >
      {askTurnOn && (
        <Popup title="Turn on AI categorization?" onClose={() => setAskTurnOn(false)}>
          <div className="p-6">
            <p>
              Your AI service is set up. Turn on AI categorization so transactions with no history get a suggested budget item? Nothing is assigned until you accept it.
            </p>
            <p className="mt-2 text-sm text-subtle">You can turn it on or off any time in Settings › Budget.</p>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button type="button" onClick={() => setAskTurnOn(false)} className={secondaryButton}>
                Not now
              </button>
              <button type="button" onClick={turnOn} disabled={busy === "turn-on"} className={primaryButton}>
                {busy === "turn-on" ? "Turning on…" : "Turn it on"}
              </button>
            </div>
          </div>
        </Popup>
      )}
      <form onSubmit={save} className="flex flex-col gap-5">
        <p className="rounded-lg bg-pressed px-3 py-2 text-sm">
          Turn AI suggestions on, and choose how they're used, in{" "}
          <a href="#/settings/budget" className="font-semibold text-link hover:underline">
            Settings › Budget
          </a>
          .{saved && <> It's {saved.enabled ? <strong>on</strong> : "off"} right now.</>}
        </p>

        <section aria-label="AI services list">
          <p className="text-sm text-subtle">Tried from the top. If one is down or doesn't answer in time, the next one is asked. Drag ⠿ (or use the arrows) to change the order.</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={services.map((d) => d.key)} strategy={verticalListSortingStrategy}>
              <ol className="mt-3 flex flex-col gap-3">
                {services.map((d, i) => (
                  <ServiceCard
                    key={d.key}
                    d={d}
                    index={i}
                    count={services.length}
                    saving={busy === "save"}
                    dirty={cardDirty(d)}
                    failed={failedCheck === d.key}
                    onSave={(skip) => void saveOne(d, skip)}
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

        {/* When to move on to the next service in the list */}
        <section aria-label="Backup AI" className="rounded-xl border border-line p-4">
          <h3 className="font-semibold">Backup AI</h3>
          <p className="mt-1 text-sm text-subtle">When to move on to the next service in the list.</p>
          <div className="mt-4 flex flex-col gap-4">
            <label className="text-sm font-medium text-subtle">
              Give up on a service after
              <span className="mt-1 flex items-center gap-2">
                <input aria-label="Seconds to wait" type="number" min={3} max={300} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} className={field + " !mt-0 max-w-[6rem]"} />
                seconds
              </span>
              <span className="mt-1 block font-normal">If it's down or hasn't answered by then, the next one is asked.</span>
            </label>
            <label className={`flex items-start gap-3 ${enabledCount < 2 ? "cursor-not-allowed" : "cursor-pointer"}`}>
              <input type="checkbox" checked={askNext} disabled={enabledCount < 2} onChange={(e) => setAskNext(e.target.checked)} className="mt-1 size-4" />
              <span>
                <span className="block font-semibold">Try the next AI if one can't pick a budget item</span>
                <span className="block text-sm text-subtle">
                  {enabledCount < 2
                    ? "Add a backup AI service above to use this."
                    : "When an AI isn't sure where a transaction goes, it's sent to the next AI in the list for a second try (for example, your home AI first, then a bigger cloud model)."}
                </span>
              </span>
            </label>
          </div>
        </section>

        <label className="text-sm font-medium text-subtle">
          Most transactions per run
          <input aria-label="Most transactions per run" type="number" min={1} max={500} value={maxPerRun} onChange={(e) => setMaxPerRun(e.target.value)} className={field + " block max-w-[8rem]"} />
          <span className="mt-1 block font-normal">Keeps costs predictable. Anything over this waits for the next run.</span>
        </label>

        <p className="rounded-lg bg-page px-3 py-2 text-sm text-subtle">
          Sent to the AI: merchant, amount, date, money in or out, account name, and your budget item names for that month. Never passwords or account numbers. Transactions that already have a suggestion from your history are never sent.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!!busy || !anyDirty} className={primaryButton}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          {anyDirty && !busy && <span className="text-sm text-subtle">Unsaved changes</span>}
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
        {failedCheck === "all" && (
          <button type="button" onClick={() => void save(undefined, true)} disabled={!!busy} className="self-start text-sm font-semibold text-error hover:underline">
            Save anyway
          </button>
        )}
      </form>
    </Card>
  );
}
