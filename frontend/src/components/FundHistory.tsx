import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type FundEntry } from "../api";
import { MONTH_NAMES } from "../dates";
import { formatCents, parseMoney } from "../money";
import { Trash } from "./Icons";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const niceDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}, ${y}`;
};

function label(e: FundEntry) {
  if (e.kind === "budgeted") {
    const [y, m] = e.date.split("-").map(Number);
    return `Budgeted · ${e.description ?? "item"} (${MONTH_NAMES[m - 1]} ${y})`;
  }
  if (e.kind === "spent") return `${e.amountCents > 0 ? "Money back" : "Spent"} · ${e.description ?? "transaction"}`;
  return e.description || (e.amountCents > 0 ? "Added by hand" : "Taken out by hand");
}

// Add money to a fund or take it out, outside the budget
export function AdjustmentForm({ fundId, onDone, onCancel }: { fundId: number; onDone: () => void; onCancel: () => void }) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseMoney(amount);
    if (!cents) return setError("Enter an amount");
    try {
      await api("POST", `/api/funds/${fundId}/entries`, {
        date,
        amountCents: direction === "in" ? cents : -cents,
        description: note.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()} aria-label="Adjust fund" className="mt-4 flex flex-col gap-3 rounded-lg bg-page p-3">
      <div role="radiogroup" aria-label="Direction" className="flex rounded-lg bg-white p-1">
        {(
          [
            ["in", "Add money"],
            ["out", "Take money out"],
          ] as const
        ).map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={direction === v}
            onClick={() => setDirection(v)}
            className={`flex-1 rounded-md py-1.5 text-sm font-semibold ${direction === v ? "bg-primary text-white" : "text-subtle"}`}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm font-medium text-subtle">
          Amount
          <input autoFocus aria-label="Adjustment amount" inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${field} tabular`} />
        </label>
        <label className="text-sm font-medium text-subtle">
          Date
          <input type="date" aria-label="Adjustment date" value={date} onChange={(e) => setDate(e.target.value)} className={field} required />
        </label>
      </div>
      <label className="text-sm font-medium text-subtle">
        Note <span className="font-normal text-muted">(optional)</span>
        <input aria-label="Adjustment note" placeholder="e.g. Birthday money" value={note} onChange={(e) => setNote(e.target.value)} className={field} />
      </label>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-pressed">
          Save
        </button>
        <button type="button" onClick={onCancel} className="rounded px-3 py-2 text-sm font-semibold text-action hover:bg-white">
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function FundHistory({ fundId, version, onChanged }: { fundId: number; version: number; onChanged: () => void }) {
  const [entries, setEntries] = useState<FundEntry[] | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => setEntries(await api<FundEntry[]>("GET", `/api/funds/${fundId}/entries`)), [fundId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load, version]);

  async function remove(id: number) {
    try {
      await api("DELETE", `/api/funds/${fundId}/entries/${id}`);
      setConfirmId(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-subtle">History</h3>
      {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
      {entries && entries.length === 0 && <p className="py-3 text-sm text-subtle">Nothing yet. Link a budget item to this fund, or add money by hand.</p>}
      <ul aria-label="Fund history" className="mt-1 max-h-80 divide-y divide-line overflow-y-auto">
        {entries?.map((e) => (
          <li key={e.id} className="group/entry flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{label(e)}</span>
              <span className="block text-xs text-subtle">
                {niceDate(e.date)}
                {!e.live && e.kind !== "adjustment" && " · item no longer linked"}
              </span>
            </span>
            <span className={`tabular shrink-0 font-medium ${e.amountCents < 0 ? "text-error" : "text-success"}`}>
              {e.amountCents > 0 ? "+" : "−"}
              {formatCents(Math.abs(e.amountCents))}
            </span>
            {!e.live ? (
              <button
                onClick={() => (confirmId === e.id ? remove(e.id) : setConfirmId(e.id))}
                onBlur={() => setConfirmId(null)}
                aria-label={confirmId === e.id ? `Confirm delete entry ${label(e)}` : `Delete entry ${label(e)}`}
                className={`shrink-0 rounded p-1 text-xs font-semibold ${confirmId === e.id ? "bg-error px-2 text-white" : "text-muted opacity-60 hover:bg-error-subtle hover:text-error group-hover/entry:opacity-100"}`}
              >
                {confirmId === e.id ? "Delete" : <Trash />}
              </button>
            ) : (
              <span className="w-6 shrink-0" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
