import { useEffect, useState } from "react";
import { api, waitingNote, type Budget, type Transaction } from "../api";
import { shortDate } from "../dates";
import { formatCents } from "../money";
import { assignmentLabel, isUnassigned, itemNames } from "./budgetLookup";

interface Props {
  budget: Budget;
  transactions: Transaction[];
  onAdd: () => void;
  onOpen: (t: Transaction) => void;
  onChanged: () => Promise<void>;
}

// For transactions imported from a bank: a "Pending" tag (right after the date, so it's never cut
// off) and the account ("Plaid Checking ••0000", shown last since it can be long)
function PendingTag({ t }: { t: Transaction }) {
  return t.pending ? <span className="ml-1.5 rounded bg-page px-1.5 py-0.5 text-xs font-semibold text-subtle">Pending</span> : null;
}
function AccountName({ t }: { t: Transaction }) {
  if (!t.account) return null;
  return (
    <>
      {" · "}
      {t.account.name}
      {t.account.mask && ` ••${t.account.mask}`}
    </>
  );
}

// An unassigned transaction, with a dashed "+ Groceries" chip when we can guess the item
function UnassignedRow({ t, onOpen, onAccept, busy }: { t: Transaction; onOpen: () => void; onAccept: () => void; busy: boolean }) {
  const s = t.suggestion;
  return (
    <li className="flex items-center gap-1 rounded-lg hover:bg-pressed">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{t.merchant}</span>
          <span className="block truncate text-sm text-subtle">
            {shortDate(t.date)}
            <PendingTag t={t} />
            <AccountName t={t} />
          </span>
        </span>
        <span className={`tabular shrink-0 ${t.type === "income" ? "text-success" : ""}`}>
          {t.type === "income" ? "+" : ""}
          {formatCents(t.amountCents)}
        </span>
      </button>
      {s && (
        <button
          onClick={onAccept}
          disabled={busy}
          title={`Assign to ${s.groupName} › ${s.itemName}`}
          aria-label={`Assign ${t.merchant} to ${s.itemName}`}
          className="mr-2 max-w-[9rem] shrink-0 truncate rounded-full border-2 border-dashed border-action/70 px-3 py-1 text-sm font-semibold text-action hover:border-solid hover:bg-white disabled:opacity-50"
        >
          + {s.itemName}
        </button>
      )}
    </li>
  );
}

export function TransactionRow({ t, label, onOpen, amountCents }: { t: Transaction; label: string; onOpen: () => void; amountCents?: number }) {
  const amount = amountCents ?? t.amountCents;
  return (
    <li>
      <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-pressed">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{t.merchant}</span>
          <span className="block truncate text-sm text-subtle">
            {shortDate(t.date)}
            <PendingTag t={t} /> · <span className={label === "Unassigned" ? "font-medium text-warning" : ""}>{label}</span>
            <AccountName t={t} />
          </span>
        </span>
        <span className={`tabular shrink-0 ${t.type === "income" ? "text-success" : ""}`}>
          {t.type === "income" ? "+" : ""}
          {formatCents(amount)}
        </span>
      </button>
    </li>
  );
}

export default function TransactionList({ budget, transactions, onAdd, onOpen, onChanged }: Props) {
  const names = itemNames(budget);
  const unassigned = transactions.filter(isUnassigned);
  const assigned = transactions.filter((t) => !isUnassigned(t));
  const withSuggestion = unassigned.filter((t) => t.suggestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasBanks, setHasBanks] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ active: boolean }[]>("GET", "/api/plaid/items")
      .then((items) => setHasBanks(items.some((i) => i.active)))
      .catch(() => setHasBanks(false));
  }, []);

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

      {unassigned.length > 0 && (
        <section aria-label="Unassigned transactions" className="mt-5 rounded-xl border border-warning/50 bg-warning/5 p-2">
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
                Accept all suggestions ({withSuggestion.length})
              </button>
            )}
          </div>
          {error && <p role="alert" className="px-2 pt-1 text-sm text-error">{error}</p>}
          <ul>
            {unassigned.map((t) => (
              <UnassignedRow
                key={t.id}
                t={t}
                busy={busy}
                onOpen={() => onOpen(t)}
                onAccept={() => run(() => api("POST", `/api/transactions/${t.id}/accept-suggestion`))}
              />
            ))}
          </ul>
          {withSuggestion.length > 0 && (
            <p className="px-2 pb-1 pt-2 text-xs text-subtle">Dashed suggestions come from how you assigned the same merchant before. Click one to accept it.</p>
          )}
        </section>
      )}

      <section aria-label="Transactions this month" className="mt-5">
        <h3 className="px-2 text-sm font-semibold uppercase tracking-wide text-subtle">This month</h3>
        {assigned.length === 0 ? (
          <p className="px-2 py-8 text-center text-subtle">No transactions yet</p>
        ) : (
          <ul className="divide-y divide-line">
            {assigned.map((t) => (
              <TransactionRow key={t.id} t={t} label={assignmentLabel(t, names)} onOpen={() => onOpen(t)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
