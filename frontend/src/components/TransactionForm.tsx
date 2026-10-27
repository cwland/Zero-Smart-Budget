import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Budget, type Transaction, type TransactionInput } from "../api";
import { defaultDateFor, monthBounds } from "../dates";
import { centsToInput, formatCents, parseMoney } from "../money";
import { ChevronLeft, Trash } from "./Icons";

// A target is "l:<lineItemId>" for budget items, "i:<incomeItemId>" for income items, "" for unassigned
type Target = string;

interface SplitDraft {
  key: number;
  target: Target;
  amount: string;
}

export interface FormPreset {
  type?: "expense" | "income";
  target?: Target;
}

interface Props {
  budget: Budget;
  existing?: Transaction;
  preset?: FormPreset;
  onSaved: () => void;
  onCancel: () => void;
}

const targetOf = (s: { lineItemId: number | null; incomeItemId: number | null }): Target =>
  s.lineItemId ? `l:${s.lineItemId}` : s.incomeItemId ? `i:${s.incomeItemId}` : "";

const splitFor = (target: Target, amountCents: number) => {
  const [kind, id] = target.split(":");
  return kind === "l" ? { lineItemId: Number(id), amountCents } : { incomeItemId: Number(id), amountCents };
};

let nextKey = 1;

export default function TransactionForm({ budget, existing, preset, onSaved, onCancel }: Props) {
  const ym = { year: budget.year, month: budget.month };
  const bounds = monthBounds(ym);
  const existingTargets = existing?.splits.map(targetOf).filter(Boolean) ?? [];

  const [type, setType] = useState<"expense" | "income">(existing?.type ?? preset?.type ?? "expense");
  const [amount, setAmount] = useState(existing ? centsToInput(existing.amountCents) : "");
  const [date, setDate] = useState(existing?.date ?? defaultDateFor(ym));
  const [merchant, setMerchant] = useState(existing?.merchant ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [target, setTarget] = useState<Target>(existingTargets.length === 1 ? existingTargets[0] : preset?.target ?? "");
  const [splitMode, setSplitMode] = useState((existing?.splits.length ?? 0) > 1);
  const [splits, setSplits] = useState<SplitDraft[]>(
    existing && existing.splits.length > 1
      ? existing.splits.map((s) => ({ key: nextKey++, target: targetOf(s), amount: centsToInput(s.amountCents) }))
      : []
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Clear an old error as soon as the user changes something
  useEffect(() => setError(""), [amount, splits, target, type, merchant]);

  const totalCents = parseMoney(amount);
  const splitSum = splits.reduce((t, s) => t + (parseMoney(s.amount) ?? 0), 0);
  const leftToSplit = (totalCents ?? 0) - splitSum;

  // Item choices for the picker, grouped like the budget
  const options = useMemo(
    () =>
      type === "income"
        ? [{ label: "Income", items: budget.income.map((i) => ({ value: `i:${i.id}`, name: i.name })) }]
        : budget.groups.map((g) => ({ label: g.name, items: g.items.map((i) => ({ value: `l:${i.id}`, name: i.name })) })),
    [budget, type]
  );

  function switchType(t: "expense" | "income") {
    if (t === type) return;
    setType(t);
    // Expense items and income items can't mix, so clear any picks
    setTarget("");
    setSplits((s) => s.map((x) => ({ ...x, target: "" })));
  }

  function startSplit() {
    setSplitMode(true);
    setSplits([
      { key: nextKey++, target, amount: amount },
      { key: nextKey++, target: "", amount: "" },
    ]);
  }

  function stopSplit() {
    setSplitMode(false);
    setTarget(splits.find((s) => s.target)?.target ?? "");
    setSplits([]);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError("");
    if (!totalCents) return setError("Enter an amount");
    if (!merchant.trim()) return setError("Enter where the money went (or came from)");

    let outSplits: TransactionInput["splits"] = [];
    if (splitMode) {
      for (const s of splits) {
        const c = parseMoney(s.amount);
        if (!c) return setError("Each split needs an amount");
        if (!s.target) return setError("Pick a budget item for each split");
        outSplits.push(splitFor(s.target, c));
      }
      if (leftToSplit !== 0) return setError(`Splits must add up to ${formatCents(totalCents)}`);
    } else if (target) {
      outSplits = [splitFor(target, totalCents)];
    }

    const body: TransactionInput = { date, merchant: merchant.trim(), amountCents: totalCents, type, note: note.trim() || null, splits: outSplits };
    setBusy(true);
    try {
      if (existing) await api("PUT", `/api/transactions/${existing.id}`, body);
      else await api("POST", "/api/transactions", body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/transactions/${existing.id}`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field = "w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
  const label = "block text-sm font-medium text-subtle";

  const picker = (value: Target, onChange: (v: Target) => void, aria: string) => (
    <select aria-label={aria} value={value} onChange={(e) => onChange(e.target.value)} className={`${field} ${value ? "" : "text-muted"}`}>
      <option value="">{type === "income" ? "Choose income item" : "Choose budget item"}</option>
      {options.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((i) => (
            <option key={i.value} value={i.value}>
              {i.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      aria-label={existing ? "Edit transaction" : "Add transaction"}
      className="flex flex-col gap-4 p-2"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onCancel} aria-label="Back" className="rounded p-1 text-action hover:bg-pressed">
          <ChevronLeft className="size-5" />
        </button>
        <h2 className="text-lg font-semibold">{existing ? "Edit Transaction" : "Add Transaction"}</h2>
      </div>

      {/* Expense / Income */}
      <div role="radiogroup" aria-label="Transaction type" className="flex rounded-lg bg-page p-1">
        {(["expense", "income"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            onClick={() => switchType(t)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold capitalize ${type === t ? "bg-white text-ink shadow-sm" : "text-subtle"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <label className={label}>
        Amount
        <div className="relative mt-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xl text-muted">$</span>
          <input
            autoFocus
            inputMode="decimal"
            aria-label="Amount"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${field} tabular pl-7 text-2xl font-semibold text-ink`}
          />
        </div>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          Date
          <input type="date" aria-label="Date" min={bounds.min} max={bounds.max} value={date} onChange={(e) => setDate(e.target.value)} className={`${field} mt-1`} required />
        </label>
        <label className={label}>
          {type === "income" ? "From" : "Merchant"}
          <input aria-label="Merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder={type === "income" ? "Employer" : "Where?"} className={`${field} mt-1`} />
        </label>
      </div>

      {!splitMode ? (
        <div>
          <span className={label}>{type === "income" ? "Income item" : "Budget item"}</span>
          <div className="mt-1">{picker(target, setTarget, "Budget item")}</div>
          <button type="button" onClick={startSplit} className="mt-2 text-sm font-semibold text-link hover:underline">
            Split
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between">
            <span className={label}>Split between</span>
            <button type="button" onClick={stopSplit} className="text-sm font-semibold text-link hover:underline">
              Don't split
            </button>
          </div>
          <div className="mt-1 flex flex-col gap-2">
            {splits.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {picker(s.target, (v) => setSplits((all) => all.map((x) => (x.key === s.key ? { ...x, target: v } : x))), `Split ${i + 1} item`)}
                </div>
                <input
                  inputMode="decimal"
                  aria-label={`Split ${i + 1} amount`}
                  placeholder="0.00"
                  value={s.amount}
                  onChange={(e) => setSplits((all) => all.map((x) => (x.key === s.key ? { ...x, amount: e.target.value } : x)))}
                  className="tabular w-28 shrink-0 rounded border border-muted/50 bg-white px-3 py-2 text-right outline-none focus:border-action focus:ring-2 focus:ring-action/15"
                />
                <button
                  type="button"
                  aria-label={`Remove split ${i + 1}`}
                  disabled={splits.length <= 2}
                  onClick={() => setSplits((all) => all.filter((x) => x.key !== s.key))}
                  className="rounded p-1 text-muted hover:text-error disabled:opacity-30"
                >
                  <Trash />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => setSplits((all) => [...all, { key: nextKey++, target: "", amount: leftToSplit > 0 ? centsToInput(leftToSplit) : "" }])}
              className="font-semibold text-link hover:underline"
            >
              Add split
            </button>
            <span role="status" className={`tabular ${leftToSplit === 0 ? "text-success" : "text-error"}`}>
              {leftToSplit === 0 ? "All assigned" : leftToSplit > 0 ? `${formatCents(leftToSplit)} left to assign` : `${formatCents(-leftToSplit)} too much`}
            </span>
          </div>
        </div>
      )}

      <label className={label}>
        Note <span className="font-normal text-muted">(optional)</span>
        <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} className={`${field} mt-1`} />
      </label>

      {error && <p role="alert" className="rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

      <button type="submit" disabled={busy} className="rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
        {existing ? "Save Changes" : "Add Transaction"}
      </button>

      {existing && (
        <button
          type="button"
          disabled={busy}
          onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          className={`rounded py-2 font-semibold ${confirmDelete ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
        >
          {confirmDelete ? "Tap again to delete" : "Delete Transaction"}
        </button>
      )}
    </form>
  );
}
