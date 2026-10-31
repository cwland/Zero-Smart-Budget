import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Card } from "./settingsUi";

interface LogRow {
  id: number;
  at: string;
  category: "email" | "ai" | "bank" | "api" | "schedule" | "access";
  level: "info" | "warning" | "error";
  source: string | null;
  event: string;
  detail: string | null;
}
type Filter = "all" | LogRow["category"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "email", label: "Email" },
  { id: "ai", label: "AI" },
  { id: "bank", label: "Bank sync" },
  { id: "api", label: "API" },
  { id: "schedule", label: "Scheduled tasks" },
  { id: "access", label: "Shared access" },
];
const CATEGORY_LABEL: Record<LogRow["category"], string> = { email: "Email", ai: "AI", bank: "Bank sync", api: "API", schedule: "Scheduled", access: "Shared access" };
const LEVEL: Record<LogRow["level"], { mark: string; cls: string; label: string }> = {
  info: { mark: "✓", cls: "text-success", label: "OK" },
  warning: { mark: "!", cls: "text-warning", label: "Warning" },
  error: { mark: "✕", cls: "text-error", label: "Error" },
};
const PAGE = 100;

// "#/settings/logs?type=email" opens with that filter
const filterFromHash = (): Filter => {
  const t = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("type");
  return (FILTERS.find((f) => f.id === t)?.id ?? "all") as Filter;
};

// Settings > Logs: one list of what the app did and what went wrong, newest first (last 30 days)
export default function LogsSettings() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>(filterFromHash);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await api<LogRow[]>("GET", "/api/logs"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // A new filter or a refresh starts back at the newest entry
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    boxRef.current?.scrollTo({ top: 0 });
  }, [filter, problemsOnly, rows]);

  // The box fills the rest of the window (above the phone's bottom menu), at least 18rem tall
  const [boxHeight, setBoxHeight] = useState<number>();
  const hasRows = !!rows?.length;
  useEffect(() => {
    const fit = () => {
      const el = boxRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bottomMenu = window.innerWidth < 640 ? 76 : 0;
      setBoxHeight(Math.max(288, window.innerHeight - top - bottomMenu - 64));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [hasRows]);

  const all = rows ?? [];
  const matches = (r: LogRow, f: Filter) => (f === "all" || r.category === f) && (!problemsOnly || r.level !== "info");
  const visible = all.filter((r) => matches(r, filter));
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

  return (
    <Card title="Logs" description="What the app has been doing, and anything that went wrong: emails, AI services, bank syncs, API requests and scheduled tasks. Kept for 30 days.">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Type of log" className="flex flex-wrap gap-1 rounded-lg bg-page p-1">
          {FILTERS.map((f) => {
            const n = all.filter((r) => matches(r, f.id)).length;
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                onClick={() => (setFilter(f.id), setShown(PAGE))}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${filter === f.id ? "bg-white text-primary shadow-sm" : "text-subtle hover:text-ink"}`}
              >
                {f.label} <span className="font-normal text-muted">{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={problemsOnly} onChange={(e) => (setProblemsOnly(e.target.checked), setShown(PAGE))} className="size-4" />
          Problems only (warnings and errors)
        </label>
        <button type="button" onClick={() => void load()} disabled={busy} className="text-sm font-semibold text-link hover:underline disabled:opacity-50">
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mt-4 text-error">{error}</p>}
      {rows && visible.length === 0 && <p className="mt-6 py-6 text-center text-subtle">Nothing logged{filter !== "all" ? " of this type" : ""}{problemsOnly ? " that went wrong" : ""} in the last 30 days.</p>}

      {visible.length > 0 && (
        // The entries scroll in their own box (about a screen tall) so the filters stay put.
        // Older entries load as you near the bottom.
        <div
          ref={boxRef}
          tabIndex={0}
          role="region"
          aria-label="Log entries (scrolls)"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (shown < visible.length && el.scrollTop + el.clientHeight > el.scrollHeight - 300) setShown((n) => n + PAGE);
          }}
          style={{ maxHeight: boxHeight ?? 288 }}
          className="mt-4 overflow-y-auto overscroll-contain rounded-lg border border-line px-3 outline-none focus-visible:ring-2 focus-visible:ring-action/30"
        >
          <ul aria-label="Log entries" className="divide-y divide-line">
            {visible.slice(0, shown).map((r) => (
              <li key={r.id} className="flex gap-3 py-2.5 text-sm">
                <span className={`w-4 shrink-0 text-center font-bold ${LEVEL[r.level].cls}`} title={LEVEL[r.level].label} aria-label={LEVEL[r.level].label}>
                  {LEVEL[r.level].mark}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">
                    <span className="mr-2 rounded bg-page px-1.5 py-0.5 text-xs font-semibold text-subtle">{CATEGORY_LABEL[r.category]}</span>
                    {r.event}
                  </span>
                  {(r.source || r.detail) && (
                    <span className="mt-0.5 block break-words text-xs text-subtle">
                      {r.source && <span className="font-semibold">{r.source}</span>}
                      {r.source && r.detail && " · "}
                      {r.detail}
                    </span>
                  )}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted">{when(r.at)}</span>
              </li>
            ))}
          </ul>
          {visible.length > shown && <p className="py-3 text-center text-xs text-muted">Scroll for older entries…</p>}
        </div>
      )}
      {visible.length > 0 && <p className="mt-2 text-xs text-muted">{visible.length} {visible.length === 1 ? "entry" : "entries"}</p>}
    </Card>
  );
}
