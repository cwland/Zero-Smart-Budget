import { useEffect, useMemo, useState } from "react";
import { api, waitingNote, type Budget, type Transaction } from "../api";
import { MONTH_NAMES, addMonths, monthBounds, shortDate, type YearMonth } from "../dates";
import { formatCents } from "../money";
import { isUnassigned } from "./budgetLookup";

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
}: {
  t: Transaction;
  label: string;
  onOpen: () => void;
  amountCents?: number;
  tone?: "item" | "subtle" | "warning";
  trailing?: React.ReactNode;
}) {
  const toneClass = tone === "item" ? "text-action" : tone === "warning" ? "font-medium text-warning" : "text-subtle";
  return (
    <li className="flex items-center gap-1 rounded-lg hover:bg-pressed">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2.5 text-left">
        <DateBadge iso={t.date} pending={t.pending} />
        <span className="sr-only">{shortDate(t.date)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{t.merchant}</span>
            {!trailing && <SignedAmount t={t} amountCents={amountCents} />}
          </span>
          <span className={`block truncate text-sm ${toneClass}`}>
            {t.pending && <span className="mr-1.5 rounded bg-page px-1.5 py-0.5 text-xs font-semibold text-subtle">Pending</span>}
            {label}
          </span>
        </span>
        {trailing && <SignedAmount t={t} amountCents={amountCents} />}
      </button>
      {trailing}
    </li>
  );
}

// An unassigned transaction, with a dashed "+ Groceries" chip when we can guess the item
function UnassignedRow({ t, onOpen, onAccept, busy }: { t: Transaction; onOpen: () => void; onAccept: () => void; busy: boolean }) {
  const s = t.suggestion;
  return (
    <TransactionRow
      t={t}
      label={accountText(t)}
      onOpen={onOpen}
      trailing={
        s ? (
          <button
            onClick={onAccept}
            disabled={busy}
            title={`Assign to ${s.groupName} › ${s.itemName}`}
            aria-label={`Assign ${t.merchant} to ${s.itemName}`}
            className="mr-2 max-w-[8.5rem] shrink-0 truncate rounded-full border-2 border-dashed border-action/70 px-3 py-1 text-sm font-semibold text-action hover:border-solid hover:bg-white disabled:opacity-50"
          >
            + {s.itemName}
          </button>
        ) : undefined
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

export default function TransactionList({ budget, transactions, onAdd, onOpen, onChanged }: Props) {
  const current: YearMonth = { year: budget.year, month: budget.month };
  const [monthsBack, setMonthsBack] = useState(1); // how many months before this one are shown
  const [earlier, setEarlier] = useState<Transaction[]>([]);
  const [oldest, setOldest] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Transaction[] | null>(null); // null = not searching
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasBanks, setHasBanks] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Back to "this month and last" when you switch months
  useEffect(() => setMonthsBack(1), [budget.year, budget.month]);

  // Earlier months' transactions. Reloads whenever this month's list does (i.e. after any change).
  useEffect(() => {
    const first = monthBounds(addMonths(current, -monthsBack)).min;
    const last = monthBounds(addMonths(current, -1)).max;
    let stale = false;
    setLoadingMore(true);
    Promise.all([api<Transaction[]>("GET", `/api/transactions?from=${first}&to=${last}`), api<{ date: string | null }>("GET", "/api/transactions/oldest")])
      .then(([list, o]) => {
        if (stale) return;
        setEarlier(list);
        setOldest(o.date);
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
      api<Transaction[]>("GET", `/api/transactions?q=${encodeURIComponent(q)}`)
        .then((r) => !stale && setResults(r))
        .catch((e) => !stale && setError((e as Error).message));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, transactions]);

  useEffect(() => {
    api<{ active: boolean }[]>("GET", "/api/plaid/items")
      .then((items) => setHasBanks(items.some((i) => i.active)))
      .catch(() => setHasBanks(false));
  }, []);

  const searching = results !== null;
  const shown = searching ? results : [...transactions, ...earlier];
  const unassigned = shown.filter(isUnassigned);
  const withSuggestion = unassigned.filter((t) => t.suggestion);

  // Month sections: when browsing, every shown month (even empty ones); when searching, only months with results
  const sections = useMemo(() => {
    const byMonth = new Map<string, Transaction[]>();
    for (const t of shown) {
      if (isUnassigned(t)) continue;
      const k = t.date.slice(0, 7);
      byMonth.set(k, [...(byMonth.get(k) ?? []), t]);
    }
    const months: YearMonth[] = searching
      ? [...byMonth.keys()].sort().reverse().map((k) => ymOf(k + "-01"))
      : Array.from({ length: monthsBack + 1 }, (_, i) => addMonths(current, -i));
    return months.map((ym) => ({ ym, list: byMonth.get(ymKey(ym)) ?? [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, searching, monthsBack, budget.year, budget.month]);

  const nextOlder = addMonths(current, -(monthsBack + 1));
  const canLoadMore = !searching && !!oldest && oldest <= monthBounds(nextOlder).max;
  const monthTitle = (ym: YearMonth) => (ym.year === current.year ? MONTH_NAMES[ym.month - 1] : `${MONTH_NAMES[ym.month - 1]} ${ym.year}`);

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

      <label className="mt-4 flex items-center gap-2 rounded-lg bg-page px-3 py-2 text-subtle focus-within:ring-2 focus-within:ring-action/20">
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
          {results.length === 0 ? `Nothing matches “${query.trim()}”` : `${results.length}${results.length === 300 ? "+" : ""} match${results.length === 1 ? "" : "es"} in all months`}
        </p>
      )}
      {error && <p role="alert" className="px-2 pt-2 text-sm text-error">{error}</p>}

      {unassigned.length > 0 && (
        <section aria-label="Unassigned transactions" className="mt-4 rounded-xl border border-warning/50 bg-warning/5 p-2">
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-subtle">
              Unassigned <span className="ml-1 rounded-full bg-warning px-2 py-0.5 text-xs text-white">{unassigned.length}</span>
            </h3>
            {withSuggestion.length > 1 && (
              <button
                disabled={busy}
                onClick={() => run(() => api("POST", "/api/transactions/accept-suggestions", { ids: withSuggestion.map((t) => t.id) }))}
                className="rounded px-2 py-1 text-sm font-semibold text-link hover:bg-white disabled:opacity-50"
              >
                Accept all ({withSuggestion.length})
              </button>
            )}
          </div>
          <ul>
            {unassigned.map((t) => (
              <UnassignedRow key={t.id} t={t} busy={busy} onOpen={() => onOpen(t)} onAccept={() => run(() => api("POST", `/api/transactions/${t.id}/accept-suggestion`))} />
            ))}
          </ul>
          {withSuggestion.length > 0 && <p className="px-2 pb-1 pt-2 text-xs text-subtle">Dashed suggestions come from how you assigned the same merchant before. Click one to accept it.</p>}
        </section>
      )}

      {sections.map(({ ym, list }) => (
        <section key={ymKey(ym)} aria-label={`${monthTitle(ym)} transactions`} className="mt-5">
          <h3 className="border-b border-line px-2 pb-2 text-lg font-semibold">{monthTitle(ym)}</h3>
          {list.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm italic text-subtle">No transactions</p>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((t) => (
                <TransactionRow key={t.id} t={t} label={assignedLabel(t)} tone="item" onOpen={() => onOpen(t)} />
              ))}
            </ul>
          )}
        </section>
      ))}

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
