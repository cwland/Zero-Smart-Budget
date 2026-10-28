import { useEffect, useMemo, useRef, useState } from "react";
import { api, waitingNote, type Budget, type Transaction } from "../api";
import { MONTH_NAMES, addMonths, monthBounds, shortDate, type YearMonth } from "../dates";
import { formatCents } from "../money";
import { isUnassigned } from "./budgetLookup";
import { setDraggedTransaction } from "../txDrag";
import { flash, setTossEnabled, targetOf as tossTarget, toss, tossOn } from "../toss";

// The transactions tab, laid out like EveryDollar's: the month you're viewing first, then the month
// before, then "Load <month> transactions" to reach further back. Search looks through everything.

interface Props {
  budget: Budget;
  transactions: Transaction[]; // the month being viewed (kept fresh by the budget page)
  onAdd: () => void;
  onOpen: (t: Transaction) => void;
  onChanged: () => Promise<void>;
}

const ymOf = (iso: string): YearMonth => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) });
const ymKey = (ym: YearMonth) => `${ym.year}-${String(ym.month).padStart(2, "0")}`;

// "-$22.22" for money out, "+$3,328.81" (green) for money in
export function SignedAmount({ t, amountCents }: { t: Transaction; amountCents?: number }) {
  const cents = amountCents ?? t.amountCents;
  return (
    <span className={`tabular shrink-0 font-semibold ${t.type === "income" ? "text-success" : ""}`}>
      {t.type === "income" ? `+${formatCents(cents)}` : `-${formatCents(cents)}`}
    </span>
  );
}

// Round "Oct / 26" badge; dashed while the bank still shows it as pending
function DateBadge({ iso, pending }: { iso: string; pending?: boolean }) {
  const [, m, d] = iso.split("-").map(Number);
  return (
    <span
      aria-hidden
      className={`flex size-10 shrink-0 flex-col items-center justify-center rounded-full border text-[11px] leading-tight text-subtle ${pending ? "border-dashed border-muted" : "border-strong"}`}
    >
      <span>{MONTH_NAMES[m - 1].slice(0, 3)}</span>
      <span>{String(d).padStart(2, "0")}</span>
    </span>
  );
}

const accountText = (t: Transaction) => (t.account ? `${t.account.name}${t.account.mask ? ` ••${t.account.mask}` : ""}` : "");

// Item name(s) for an assigned transaction
export function assignedLabel(t: Transaction) {
  const parts = t.splits.filter((s) => s.lineItemId || s.incomeItemId);
  if (parts.length > 1) return `Split · ${parts.length} items`;
  return parts[0]?.itemName ?? "Assigned";
}

// One transaction. `sub` is the second line (item name, account, ...); `subTone` colors it.
export function TransactionRow({
  t,
  label,
  onOpen,
  amountCents,
  tone = "subtle",
  trailing,
  draggable,
  hidePending,
  leading,
}: {
  t: Transaction;
  label: string;
  onOpen: () => void;
  amountCents?: number;
  tone?: "item" | "subtle" | "warning";
  trailing?: React.ReactNode;
  draggable?: boolean; // can be dragged onto a budget item
  hidePending?: boolean; // in the Pending tab every row is pending, so no tag
  leading?: React.ReactNode; // e.g. a checkbox, left of the date
}) {
  const toneClass = tone === "item" ? "text-action" : tone === "warning" ? "font-medium text-warning" : "text-subtle";
  return (
    <li
      className={`relative rounded-lg hover:bg-pressed ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      draggable={draggable}
      data-tx-row={t.id}
      title={draggable ? "Drag onto a budget item to assign it" : undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.merchant);
        e.dataTransfer.effectAllowed = "move";
        setDraggedTransaction(t);
      }}
      onDragEnd={() => setDraggedTransaction(null)}
    >
      {leading && <span className="absolute left-1 top-1/2 -translate-y-1/2">{leading}</span>}
      <button onClick={onOpen} className={`flex w-full min-w-0 items-center gap-3 py-2.5 pr-2 text-left ${leading ? "pl-8" : "pl-2"}`}>
        <DateBadge iso={t.date} pending={t.pending} />
        <span className="sr-only">{shortDate(t.date)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{t.merchant}</span>
            <SignedAmount t={t} amountCents={amountCents} />
          </span>
          {/* Second line; leaves room on the right for a suggestion chip */}
          <span className={`block min-h-[1.75rem] truncate pt-1 text-sm ${toneClass} ${trailing ? "pr-[9.5rem]" : ""}`}>
            {t.pending && !hidePending && <span className="mr-1.5 rounded bg-page px-1.5 py-0.5 text-xs font-semibold text-subtle">Pending</span>}
            {label}
          </span>
        </span>
      </button>
      {trailing && <span className="absolute bottom-2 right-2">{trailing}</span>}
    </li>
  );
}

// An unassigned transaction, with a dashed "+ Groceries" chip when we can guess the item
// Chip colors: blue dashed = learned from your history; purple with a sparkle = the AI's guess
const HISTORY_CHIP = "border-action/70 text-action";
const AI_CHIP = "border-[#7c4dff]/70 text-[#6a3de8]";

function UnassignedRow({
  t,
  onOpen,
  onAccept,
  onAskAi,
  busy,
  draggable,
  selected,
  onToggle,
}: {
  t: Transaction;
  onOpen: () => void;
  onAccept: () => void;
  onAskAi?: () => void; // shown when AI is on and there's no suggestion yet
  busy: boolean;
  draggable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const s = t.suggestion;
  const a = !s ? t.aiSuggestion : null;
  const chip = s ?? a;
  return (
    <TransactionRow
      t={t}
      label={accountText(t)}
      onOpen={onOpen}
      draggable={draggable}
      leading={<input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${t.merchant}`} className="size-4 cursor-pointer accent-[#0073b9]" />}
      trailing={
        chip ? (
          <button
            onClick={onAccept}
            disabled={busy}
            title={a ? `AI guess: ${a.groupName} › ${a.itemName}${a.reason ? ` (${a.reason})` : ""}` : `From your history: ${chip.groupName} › ${chip.itemName}`}
            aria-label={`Assign ${t.merchant} to ${chip.itemName}${a ? " (AI suggestion)" : ""}`}
            className={`block max-w-[9rem] truncate rounded-full border-2 border-dashed bg-white px-3 py-0.5 text-sm font-semibold hover:border-solid hover:bg-pressed disabled:opacity-50 ${a ? AI_CHIP : HISTORY_CHIP}`}
          >
            {a ? "✦" : "+"} {chip.itemName}
          </button>
        ) : onAskAi ? (
          <button onClick={onAskAi} disabled={busy} aria-label={`Ask AI about ${t.merchant}`} className="rounded-full px-2 py-0.5 text-sm font-semibold text-[#6a3de8] hover:bg-[#7c4dff]/10 disabled:opacity-50">
            ✦ Ask AI
          </button>
        ) : undefined
      }
    />
  );
}

// A deleted transaction: Restore puts it back (with its old item when possible); the trash can
// erases it for good after a second click
function DeletedRow({ t, busy, onRestore, onErase }: { t: Transaction; busy: boolean; onRestore: () => void; onErase: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const when = t.deletedAt ? new Date(t.deletedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return (
    <TransactionRow
      t={t}
      label={`Deleted ${when}${accountText(t) ? ` · ${accountText(t)}` : ""}`}
      onOpen={() => setConfirm(false)}
      trailing={
        <span className="flex items-center gap-1">
          {confirm ? (
            <button onClick={onErase} disabled={busy} onBlur={() => setConfirm(false)} className="rounded bg-error px-2 py-0.5 text-sm font-semibold text-white disabled:opacity-50">
              Delete forever
            </button>
          ) : (
            <>
              <button onClick={onRestore} disabled={busy} aria-label={`Restore ${t.merchant}`} className="rounded-full border-2 border-action/70 bg-white px-3 py-0.5 text-sm font-semibold text-action hover:bg-pressed disabled:opacity-50">
                Restore
              </button>
              <button onClick={() => setConfirm(true)} disabled={busy} aria-label={`Delete ${t.merchant} forever`} title="Delete forever" className="rounded p-1 text-muted hover:bg-error-subtle hover:text-error">
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
                </svg>
              </button>
            </>
          )}
        </span>
      }
    />
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

type Tab = "new" | "tracked" | "pending" | "deleted";

// New: waiting to be assigned. Tracked: assigned. Pending: not posted at the bank yet (an assigned
// pending charge stays in Tracked, tagged Pending).
const TAB_NAMES: Record<Tab, string> = { new: "New", tracked: "Tracked", deleted: "Deleted", pending: "Pending" };

const tabOf = (t: Transaction): Tab => (t.deletedAt ? "deleted" : !isUnassigned(t) ? "tracked" : t.pending ? "pending" : "new");

// Remembered while you open a transaction and come back (the list is rebuilt each time)
const remembered = { tab: "new" as Tab, monthsBack: 1, month: "" };

export default function TransactionList({ budget, transactions, onAdd, onOpen, onChanged }: Props) {
  const current: YearMonth = { year: budget.year, month: budget.month };
  const sameMonth = remembered.month === ymKey(current);
  const [tab, setTabState] = useState<Tab>(remembered.tab);
  const [monthsBack, setMonthsBackState] = useState(sameMonth ? remembered.monthsBack : 1); // months before this one that are shown
  const setTab = (t: Tab) => {
    remembered.tab = t;
    setTabState(t);
  };
  const setMonthsBack = (fn: (n: number) => number) =>
    setMonthsBackState((n) => {
      const next = fn(n);
      remembered.monthsBack = next;
      return next;
    });
  remembered.month = ymKey(current);
  const [earlier, setEarlier] = useState<Transaction[]>([]);
  const [deleted, setDeleted] = useState<Transaction[]>([]); // deleted ones in the shown months
  const [oldest, setOldest] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Transaction[] | null>(null); // null = not searching
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasBanks, setHasBanks] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Back to "this month and last" when you switch months
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setMonthsBack(() => 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget.year, budget.month]);

  // Earlier months' transactions. Reloads whenever this month's list does (i.e. after any change).
  useEffect(() => {
    const first = monthBounds(addMonths(current, -monthsBack)).min;
    const last = monthBounds(addMonths(current, -1)).max;
    let stale = false;
    setLoadingMore(true);
    Promise.all([
      api<Transaction[]>("GET", `/api/transactions?from=${first}&to=${last}`),
      api<{ date: string | null }>("GET", "/api/transactions/oldest"),
      api<Transaction[]>("GET", `/api/transactions?deleted=true&from=${first}&to=${monthBounds(current).max}`),
    ])
      .then(([list, o, del]) => {
        if (stale) return;
        setEarlier(list);
        setOldest(o.date);
        setDeleted(del);
      })
      .catch((e) => !stale && setError((e as Error).message))
      .finally(() => !stale && setLoadingMore(false));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget.year, budget.month, monthsBack, transactions]);

  // Search (waits for a pause in typing); re-runs after changes so results stay current
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      Promise.all([api<Transaction[]>("GET", `/api/transactions?q=${encodeURIComponent(q)}`), api<Transaction[]>("GET", `/api/transactions?q=${encodeURIComponent(q)}&deleted=true`)])
        .then(([live, del]) => !stale && setResults([...live, ...del]))
        .catch((e) => !stale && setError((e as Error).message));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, transactions]);

  useEffect(() => {
    api<{ tossAnimation: boolean }>("GET", "/api/settings/budget")
      .then((p) => setTossEnabled(p.tossAnimation))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api<{ enabled: boolean }>("GET", "/api/ai/status")
      .then((r) => setAiOn(r.enabled))
      .catch(() => setAiOn(false));
  }, []);

  useEffect(() => {
    api<{ active: boolean }[]>("GET", "/api/plaid/items")
      .then((items) => setHasBanks(items.some((i) => i.active)))
      .catch(() => setHasBanks(false));
  }, []);

  const searching = results !== null;
  const shown = searching ? results : [...transactions, ...earlier, ...deleted];
  const byTab = {
    new: shown.filter((t) => tabOf(t) === "new"),
    tracked: shown.filter((t) => tabOf(t) === "tracked"),
    pending: shown.filter((t) => tabOf(t) === "pending"),
    deleted: shown.filter((t) => tabOf(t) === "deleted"),
  };
  const list = byTab[tab];
  const withSuggestion = byTab.new.filter((t) => t.suggestion || t.aiSuggestion); // history or AI
  const withoutSuggestion = byTab.new.filter((t) => !t.suggestion && !t.aiSuggestion);
  const inThisMonth = (t: Transaction) => t.date.startsWith(ymKey(current));

  // Month sections: when browsing, every shown month (even empty ones); when searching, only months with results
  const sections = useMemo(() => {
    const byMonth = new Map<string, Transaction[]>();
    for (const t of list) {
      const k = t.date.slice(0, 7);
      byMonth.set(k, [...(byMonth.get(k) ?? []), t]);
    }
    const months: YearMonth[] = searching
      ? [...byMonth.keys()].sort().reverse().map((k) => ymOf(k + "-01"))
      : Array.from({ length: monthsBack + 1 }, (_, i) => addMonths(current, -i));
    return months.map((ym) => ({ ym, list: byMonth.get(ymKey(ym)) ?? [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, searching, monthsBack, budget.year, budget.month]);

  const nextOlder = addMonths(current, -(monthsBack + 1));
  const canLoadMore = !searching && tab !== "pending" && !!oldest && oldest <= monthBounds(nextOlder).max;
  const monthTitle = (ym: YearMonth) => (ym.year === current.year ? MONTH_NAMES[ym.month - 1] : `${MONTH_NAMES[ym.month - 1]} ${ym.year}`);
  const pendingIn = byTab.pending.filter((t) => t.type === "income").reduce((n, t) => n + t.amountCents, 0);
  const pendingOut = byTab.pending.filter((t) => t.type === "expense").reduce((n, t) => n + t.amountCents, 0);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Accept suggestions (history first, else the AI's), tossing each into its budget item.
  // Up to 6 are animated one after another (each scrolled into view first); the rest just land.
  async function accept(list: Transaction[]) {
    if (!list.length) return;
    setBusy(true);
    setError("");
    const targets: string[] = [];
    try {
      const saving = list.length === 1 ? api("POST", `/api/transactions/${list[0].id}/accept-suggestion`) : api("POST", "/api/transactions/accept-suggestions", { ids: list.map((t) => t.id) });
      if (tossOn()) {
        for (const t of list.slice(0, 6)) {
          const s = t.suggestion ?? t.aiSuggestion;
          if (!s) continue;
          const target = tossTarget(s);
          targets.push(target);
          await toss(document.querySelector<HTMLElement>(`[data-tx-row="${t.id}"]`), target, { ai: !t.suggestion });
        }
      }
      await saving;
      setSelected(new Set());
      await onChanged();
      targets.forEach(flash); // the catch, on the refreshed rows
    } catch (e) {
      setError((e as Error).message);
      await onChanged().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  // Ask the AI about specific transactions (asks again even if it looked before)
  async function askAi(ids: number[]) {
    setAiMsg(null);
    setBusy(true);
    setError("");
    try {
      const r = await api<{ asked: number; suggested: number; noMatch: number; skipped: { reason: string; count: number }[]; error?: string }>("POST", "/api/transactions/ai-suggest", { ids, force: true });
      const parts = [r.suggested && `${r.suggested} suggested`, r.noMatch && `${r.noMatch} with no good fit`].filter(Boolean);
      const skipped = r.skipped.map((x) => `${x.count} ${x.reason}`).join("; ");
      if (r.error) setAiMsg({ ok: false, text: r.error });
      else setAiMsg({ ok: true, text: `AI: ${parts.length ? parts.join(", ") : "nothing to ask"}${skipped ? ` (skipped ${skipped})` : ""}.` });
      setSelected(new Set());
      await onChanged();
    } catch (e) {
      setAiMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedRows = byTab.new.filter((t) => selected.has(t.id));
  const selectedWithSuggestion = selectedRows.filter((t) => t.suggestion || t.aiSuggestion);

  async function syncBanks() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api<{ added: number; updated: number; removed: number; results: { error?: string }[]; waiting: { year: number; month: number; count: number }[] }>("POST", "/api/plaid/sync");
      const problems = r.results.filter((x) => x.error).map((x) => x.error);
      const parts = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
      setSyncMsg(problems.length ? { ok: false, text: problems.join(" ") } : { ok: true, text: (parts.length ? `Bank sync: ${parts.join(", ")}.` : "Bank sync: nothing new.") + waitingNote(r.waiting) });
      await onChanged();
    } catch (e) {
      setSyncMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="p-2">
      <button onClick={onAdd} className="w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed">
        Add Transaction
      </button>
      {hasBanks && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
          <button onClick={syncBanks} disabled={syncing} className="text-sm font-semibold text-link hover:underline disabled:opacity-50">
            {syncing ? "Syncing banks…" : "Sync bank transactions"}
          </button>
          {syncMsg && (
            <span role={syncMsg.ok ? "status" : "alert"} className={`text-sm ${syncMsg.ok ? "text-success" : "text-error"}`}>
              {syncMsg.text}
            </span>
          )}
        </div>
      )}

      <div role="tablist" aria-label="Transaction lists" className="mt-4 flex border-b border-line text-sm">
        {(["new", "tracked", "deleted", "pending"] as Tab[]).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px flex-1 whitespace-nowrap border-b-[3px] px-0.5 pb-2 pt-1 font-semibold ${tab === id ? "border-action text-action" : "border-transparent text-subtle hover:text-ink"}`}
          >
            {TAB_NAMES[id]} ({byTab[id].length})
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 rounded-lg bg-page px-3 py-2 text-subtle focus-within:ring-2 focus-within:ring-action/20">
        <SearchIcon />
        <input
          type="search"
          aria-label="Search transactions"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-subtle"
        />
      </label>
      {searching && (
        <p role="status" className="px-2 pt-2 text-sm text-subtle">
          {list.length === 0
            ? `Nothing in ${TAB_NAMES[tab]} matches “${query.trim()}”${results.length ? ` (${results.length} in other tabs)` : ""}`
            : `${list.length} match${list.length === 1 ? "" : "es"} in all months`}
        </p>
      )}
      {error && <p role="alert" className="px-2 pt-2 text-sm text-error">{error}</p>}

      {tab === "new" && byTab.new.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1 pt-2">
          {selectedRows.length > 0 ? (
            <>
              <span className="mr-auto px-2 text-sm text-subtle">{selectedRows.length} selected</span>
              {aiOn && (
                <button disabled={busy} onClick={() => askAi(selectedRows.map((t) => t.id))} className="rounded px-2 py-1 text-sm font-semibold text-[#6a3de8] hover:bg-[#7c4dff]/10 disabled:opacity-50">
                  ✦ Ask AI ({selectedRows.length})
                </button>
              )}
              {selectedWithSuggestion.length > 0 && (
                <button
                  disabled={busy}
                  onClick={() => accept(selectedWithSuggestion)}
                  className="rounded px-2 py-1 text-sm font-semibold text-link hover:bg-pressed disabled:opacity-50"
                >
                  Accept ({selectedWithSuggestion.length})
                </button>
              )}
              <button onClick={() => setSelected(new Set())} className="rounded px-2 py-1 text-sm text-subtle hover:bg-pressed">
                Clear
              </button>
            </>
          ) : (
            <>
              {aiOn && withoutSuggestion.length > 0 && (
                <button disabled={busy} onClick={() => askAi(withoutSuggestion.map((t) => t.id))} className="rounded px-2 py-1 text-sm font-semibold text-[#6a3de8] hover:bg-[#7c4dff]/10 disabled:opacity-50">
                  ✦ Ask AI for all ({withoutSuggestion.length})
                </button>
              )}
              {withSuggestion.length > 1 && (
                <button
                  disabled={busy}
                  onClick={() => accept(withSuggestion)}
                  className="rounded px-2 py-1 text-sm font-semibold text-link hover:bg-pressed disabled:opacity-50"
                >
                  Accept all suggestions ({withSuggestion.length})
                </button>
              )}
            </>
          )}
        </div>
      )}
      {aiMsg && (
        <p role={aiMsg.ok ? "status" : "alert"} className={`px-2 pt-1 text-sm ${aiMsg.ok ? "text-[#6a3de8]" : "text-error"}`}>
          {aiMsg.text}
        </p>
      )}

      {tab === "pending" ? (
        <section aria-label="Pending transactions" className="mt-3">
          <p className="px-2 text-sm text-subtle">
            Pending transactions haven't posted at your bank yet. They move to New when they clear, and the amount or date can change a little by then.
          </p>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-2 text-sm">
            <dt className="text-subtle">Total pending income</dt>
            <dd className="tabular text-right font-semibold text-success">{formatCents(pendingIn)}</dd>
            <dt className="text-subtle">Total pending expenses</dt>
            <dd className="tabular text-right font-semibold">-{formatCents(pendingOut)}</dd>
          </dl>
          {list.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm italic text-subtle">No pending transactions</p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {list.map((t) => (
                <TransactionRow key={t.id} t={t} label={accountText(t)} hidePending onOpen={() => onOpen(t)} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        sections.map(({ ym, list: rows }) => (
          <section key={ymKey(ym)} aria-label={`${monthTitle(ym)} transactions`} className="mt-5">
            <h3 className="flex items-center gap-2 border-b border-line px-2 pb-2 text-lg font-semibold">
              {tab === "new" && rows.length > 0 && (
                <input
                  type="checkbox"
                  aria-label={`Select all in ${monthTitle(ym)}`}
                  checked={rows.every((t) => selected.has(t.id))}
                  onChange={(e) =>
                    setSelected((cur) => {
                      const next = new Set(cur);
                      rows.forEach((t) => (e.target.checked ? next.add(t.id) : next.delete(t.id)));
                      return next;
                    })
                  }
                  className="size-4 cursor-pointer accent-[#0073b9]"
                />
              )}
              {monthTitle(ym)}
            </h3>
            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm italic text-subtle">No transactions</p>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((t) =>
                  tab === "new" ? (
                    <UnassignedRow
                      key={t.id}
                      t={t}
                      busy={busy}
                      draggable={inThisMonth(t)}
                      onOpen={() => onOpen(t)}
                      onAccept={() => accept([t])}
                      onAskAi={aiOn ? () => askAi([t.id]) : undefined}
                      selected={selected.has(t.id)}
                      onToggle={() => toggle(t.id)}
                    />
                  ) : tab === "deleted" ? (
                    <DeletedRow key={t.id} t={t} busy={busy} onRestore={() => run(() => api("POST", `/api/transactions/${t.id}/restore`))} onErase={() => run(() => api("DELETE", `/api/transactions/${t.id}?permanent=true`))} />
                  ) : (
                    <TransactionRow key={t.id} t={t} label={assignedLabel(t)} tone="item" draggable={inThisMonth(t) && t.splits.length === 1} onOpen={() => onOpen(t)} />
                  )
                )}
              </ul>
            )}
          </section>
        ))
      )}

      {tab === "new" && byTab.new.length > 0 && (
        <p className="px-2 pt-3 text-xs text-subtle">
          Drag a transaction onto a budget item to assign it, or click a suggestion:{" "}
          <span className="font-semibold text-action">+ blue</span> learned from your history, <span className="font-semibold text-[#6a3de8]">✦ purple</span> the AI's guess.
        </p>
      )}

      {canLoadMore && (
        <div className="py-4 text-center">
          <button onClick={() => setMonthsBack((n) => n + 1)} disabled={loadingMore} className="text-sm font-semibold text-link underline hover:no-underline disabled:opacity-50">
            {loadingMore ? "Loading…" : `Load ${monthTitle(nextOlder)} Transactions`}
          </button>
        </div>
      )}
    </div>
  );
}
