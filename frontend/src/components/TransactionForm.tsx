import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { api, type Budget, type Suggestion, type Transaction, type TransactionInput } from "../api";
import { defaultDateFor, monthBounds } from "../dates";
import { centsToInput, formatCents, parseMoney } from "../money";
import { ChevronDown, ChevronUp, CloseIcon, Trash } from "./Icons";
import { useLockBodyScroll } from "../scrollLock";

// The Add / Edit transaction popup, laid out like EveryDollar's:
// Expense|Income switch, amount, date + merchant (with the bank's own wording under it), account,
// "Budget Items" (pick one, or several to split), More Options (Check #, Note), then
// Delete · Cancel · Save Changes.

// A target is "l:<lineItemId>" for budget items, "i:<incomeItemId>" for income items
type Target = string;

interface Pick {
  key: number;
  target: Target;
  amount: string; // used when splitting between several items
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

interface AccountOption {
  accountId: string;
  label: string; // "High Yield Spending *4986"
}

const suggestionTarget = (s: Suggestion | null | undefined): Target =>
  !s ? "" : s.lineItemId ? `l:${s.lineItemId}` : s.incomeItemId ? `i:${s.incomeItemId}` : "";

const targetOf = (s: { lineItemId: number | null; incomeItemId: number | null }): Target =>
  s.lineItemId ? `l:${s.lineItemId}` : s.incomeItemId ? `i:${s.incomeItemId}` : "";

const splitFor = (target: Target, amountCents: number) => {
  const [kind, id] = target.split(":");
  return kind === "l" ? { lineItemId: Number(id), amountCents } : { incomeItemId: Number(id), amountCents };
};

// "3328.81" -> "$3,328.81" for the amount box when it isn't being typed in
const pretty = (text: string) => {
  const c = parseMoney(text);
  return c ? formatCents(c) : text;
};

let nextKey = 1;

export default function TransactionForm({ budget, existing, preset, onSaved, onCancel }: Props) {
  const ym = { year: budget.year, month: budget.month };
  const bounds = monthBounds(ym);
  const existingTargets = existing?.splits.map(targetOf).filter(Boolean) ?? [];

  const [type, setType] = useState<"expense" | "income">(existing?.type ?? preset?.type ?? "expense");
  const [amount, setAmount] = useState(existing ? formatCents(existing.amountCents) : "");
  const [date, setDate] = useState(existing?.date ?? defaultDateFor(ym));
  const [merchant, setMerchant] = useState(existing?.merchant ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [checkNumber, setCheckNumber] = useState(existing?.checkNumber ?? "");
  const [accountId, setAccountId] = useState(existing?.plaidAccountId ?? "");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [moreOpen, setMoreOpen] = useState(!!(existing?.note || existing?.checkNumber));

  // Starting item(s): the transaction's own, else the item it was opened from, else last time's
  // (history), else the AI's guess
  const initialTarget: Target = preset?.target ?? suggestionTarget(existing?.suggestion) ?? "";
  const aiTarget = !initialTarget && existingTargets.length === 0 ? suggestionTarget(existing?.aiSuggestion) : "";
  const [picks, setPicks] = useState<Pick[]>(
    existing && existing.splits.length > 0
      ? existing.splits.map((s) => ({ key: nextKey++, target: targetOf(s), amount: centsToInput(s.amountCents) }))
      : initialTarget || aiTarget
        ? [{ key: nextKey++, target: initialTarget || aiTarget, amount: "" }]
        : []
  );
  // Once the user picks items themselves, stop auto-picking from merchant history
  const [touched, setTouched] = useState(existingTargets.length > 0 || !!preset?.target);
  const [autoNote, setAutoNote] = useState<{ name: string; source: "history" | "ai" } | null>(
    existingTargets.length === 0 && existing?.suggestion
      ? { name: existing.suggestion.itemName, source: "history" }
      : existingTargets.length === 0 && aiTarget && existing?.aiSuggestion
        ? { name: existing.aiSuggestion.itemName, source: "ai" }
        : null
  );
  const [merchantOptions, setMerchantOptions] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useLockBodyScroll(); // the page behind stays put while this is open
  const pickerRef = useRef<HTMLDivElement>(null);

  // Connected bank accounts for the account box
  useEffect(() => {
    api<{ institutions: { accounts: { accountId: string; name: string; mask: string | null }[] }[]; manual: { key: string; name: string }[] }>("GET", "/api/accounts")
      .then((d) =>
        setAccounts([
          ...d.institutions.flatMap((i) => i.accounts.map((a) => ({ accountId: a.accountId, label: `${a.name}${a.mask ? ` *${a.mask}` : ""}` }))),
          ...d.manual.map((m) => ({ accountId: m.key, label: m.name })),
        ])
      )
      .catch(() => setAccounts([]));
  }, []);

  // Autocomplete merchants you've used before
  useEffect(() => {
    const q = merchant.trim();
    const timer = setTimeout(() => {
      api<string[]>("GET", `/api/merchants?q=${encodeURIComponent(q)}&limit=8`)
        .then((list) => setMerchantOptions(list.filter((m) => m !== merchant)))
        .catch(() => setMerchantOptions([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [merchant]);

  // Pick the item this merchant went to last time (until the user picks one themselves)
  useEffect(() => {
    if (touched || picks.length > 1 || merchant.trim().length < 2) return;
    const timer = setTimeout(() => {
      const cents = parseMoney(amount);
      api<{ suggestion: Suggestion | null }>("GET", `/api/transactions/suggest?merchant=${encodeURIComponent(merchant)}&date=${date}&type=${type}${cents ? `&amountCents=${cents}` : ""}`)
        .then(({ suggestion }) => {
          if (!suggestion) return;
          setPicks([{ key: nextKey++, target: suggestionTarget(suggestion), amount: "" }]);
          setAutoNote({ name: suggestion.itemName, source: "history" });
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant, date, type, touched]);

  // Esc closes (the item list first, if it's open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pickerOpen) setPickerOpen(false);
      else onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pickerOpen, onCancel]);

  // Close the item list when clicking elsewhere
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  useEffect(() => setError(""), [amount, picks, type, merchant]);

  const totalCents = parseMoney(amount);
  const splitting = picks.length > 1;
  const splitSum = picks.reduce((t, p) => t + (parseMoney(p.amount) ?? 0), 0);
  const leftToSplit = (totalCents ?? 0) - splitSum;

  // Item choices, grouped like the budget. Expenses go to budget items. Income goes to income items,
  // or to a budget item as money back (a refund, or the incoming side of a transfer into a fund).
  const groups = useMemo(() => {
    const favs = budget.groups.flatMap((g) => g.items.filter((i) => i.favorite)).map((i) => ({ value: `l:${i.id}`, name: i.name }));
    const list = [
      ...(favs.length ? [{ label: "★ Favorites", items: favs }] : []),
      ...budget.groups.map((g) => ({ label: g.name, items: g.items.map((i) => ({ value: `l:${i.id}`, name: i.name })) })),
    ];
    return type === "income" ? [{ label: "Income", items: budget.income.map((i) => ({ value: `i:${i.id}`, name: i.name })) }, ...list] : list;
  }, [budget, type]);
  const nameOf = (t: Target) => groups.flatMap((g) => g.items).find((i) => i.value === t)?.name ?? "";
  const isPicked = (t: Target) => picks.some((p) => p.target === t);

  function togglePick(t: Target) {
    setTouched(true);
    setAutoNote(null);
    setPicks((cur) => {
      if (cur.some((p) => p.target === t)) return cur.filter((p) => p.target !== t);
      const next = [...cur, { key: nextKey++, target: t, amount: "" }];
      // Starting a split: the first item gets the full amount, the new one the rest (nothing yet)
      if (next.length === 2 && !cur[0].amount) next[0] = { ...next[0], amount: totalCents ? centsToInput(totalCents) : "" };
      return next;
    });
  }

  function switchType(t: "expense" | "income") {
    if (t === type) return;
    setType(t);
    // Expenses can't go to income items, so drop those picks (budget items are fine either way)
    if (t === "expense") setPicks((cur) => cur.filter((p) => !p.target.startsWith("i:")));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError("");
    if (!totalCents) return setError("Enter an amount");
    if (!merchant.trim()) return setError("Enter where the money went (or came from)");

    let splits: TransactionInput["splits"] = [];
    if (splitting) {
      for (const p of picks) {
        const c = parseMoney(p.amount);
        if (!c) return setError(`Enter an amount for ${nameOf(p.target)}`);
        splits.push(splitFor(p.target, c));
      }
      if (leftToSplit !== 0) return setError(`The items must add up to ${formatCents(totalCents)}`);
    } else if (picks[0]) {
      splits = [splitFor(picks[0].target, totalCents)];
    }

    const body: TransactionInput = {
      date,
      merchant: merchant.trim(),
      amountCents: totalCents,
      type,
      note: note.trim() || null,
      checkNumber: checkNumber.trim() || null,
      plaidAccountId: accountId || null,
      splits,
    };
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

  const box = "w-full rounded-lg border border-muted/60 bg-white px-4 py-3 text-base outline-none focus:border-action focus:ring-2 focus:ring-action/15";
  const kind = type === "income" ? "Income" : "Expense";
  const title = `${existing ? "Edit" : "Add"} ${kind}`;
  const accountKnown = !accountId || accounts.some((a) => a.accountId === accountId);

  // Drawn at the top of the page (a portal) so it covers the menu and headers too
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[94vh] w-full max-w-[30rem] flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_12px_40px_rgba(31,36,38,0.3)] sm:rounded-2xl"
      >
        <header className={`relative flex items-center justify-center px-12 py-5 ${type === "income" ? "bg-success-subtle" : "bg-page"}`}>
          <h2 className="text-xl font-bold">{title}</h2>
          <button type="button" onClick={onCancel} aria-label="Close" className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1.5 text-subtle hover:bg-white/70 hover:text-ink">
            <CloseIcon />
          </button>
        </header>

        <form onSubmit={submit} aria-label={existing ? "Edit transaction" : "Add transaction"} className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-6 pb-4 pt-5">
            {/* Expense / Income */}
            <div role="radiogroup" aria-label="Transaction type" className="flex rounded-lg bg-page p-1">
              {(["expense", "income"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={type === t}
                  onClick={() => switchType(t)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md py-2 font-semibold ${type === t ? "bg-white text-ink shadow-sm" : "text-subtle hover:text-ink"}`}
                >
                  <span aria-hidden className="text-lg leading-none">{t === "expense" ? "−" : "+"}</span>
                  {t === "expense" ? "Expense" : "Income"}
                </button>
              ))}
            </div>

            <input
              autoFocus={!existing}
              inputMode="decimal"
              aria-label="Amount"
              placeholder="$0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onFocus={(e) => {
                const c = parseMoney(amount);
                if (c) setAmount(centsToInput(c));
                requestAnimationFrame(() => e.target.select());
              }}
              onBlur={() => setAmount((a) => pretty(a))}
              className={`${box} tabular`}
            />

            <div className="grid grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] gap-3">
              <input type="date" aria-label="Date" min={bounds.min} max={bounds.max} value={date} onChange={(e) => setDate(e.target.value)} className={box} required />
              <div className="min-w-0">
                <input
                  aria-label="Merchant"
                  list="merchant-options"
                  autoComplete="off"
                  value={merchant}
                  onChange={(e) => setMerchant(e.target.value)}
                  placeholder={type === "income" ? "Where's it from?" : "Where'd you spend it?"}
                  className={box}
                />
                <datalist id="merchant-options">
                  {merchantOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {existing?.originalDescription && <p className="mt-1 break-words px-1 text-xs text-subtle">{existing.originalDescription}</p>}
              </div>
            </div>

            <div className="relative">
              <select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={`${box} appearance-none pr-10 ${accountId ? "" : "text-subtle"}`}>
                <option value="">{accounts.length ? "No account" : "No bank accounts connected"}</option>
                {!accountKnown && <option value={accountId}>{existing?.account ? `${existing.account.name}${existing.account.mask ? ` *${existing.account.mask}` : ""}` : "Disconnected account"}</option>}
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 size-5 -translate-y-1/2 text-subtle" />
            </div>

            {/* Budget Items: pick one, or several to split */}
            <div ref={pickerRef} className="relative">
              <span id="budget-items-label" className="block font-bold">
                Budget Items
              </span>
              <button
                type="button"
                aria-labelledby="budget-items-label"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((o) => !o)}
                className={`${box} mt-2 flex items-center justify-between gap-2 text-left`}
              >
                <span className={`min-w-0 truncate ${picks.length ? "text-ink" : "text-subtle"}`}>
                  {picks.length === 0 ? "Choose Budget Item(s)" : picks.length === 1 ? nameOf(picks[0].target) : `Split · ${picks.length} items`}
                </span>
                {pickerOpen ? <ChevronUp className="size-5 shrink-0 text-subtle" /> : <ChevronDown className="size-5 shrink-0 text-subtle" />}
              </button>
              {pickerOpen && (
                <div role="listbox" aria-label="Budget items" aria-multiselectable="true" className="absolute inset-x-0 z-10 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-line bg-white py-1 shadow-[0_8px_24px_rgba(31,36,38,0.18)]">
                  {groups.map((g) => (
                    <div key={g.label}>
                      <div className="sticky top-0 bg-page px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">
                        {g.label}
                        {type === "income" && g.label !== "Income" && <span className="font-normal normal-case"> · money back</span>}
                      </div>
                      {g.items.map((i) => (
                        <label key={g.label + i.value} role="option" aria-selected={isPicked(i.value)} className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-pressed">
                          <input type="checkbox" checked={isPicked(i.value)} onChange={() => togglePick(i.value)} className="size-4 accent-[#0073b9]" />
                          <span className="min-w-0 flex-1 truncate">{i.name}</span>
                        </label>
                      ))}
                      {g.items.length === 0 && <p className="px-4 py-2 text-sm italic text-subtle">No items</p>}
                    </div>
                  ))}
                  <div className="sticky bottom-0 flex justify-end border-t border-line bg-white px-3 py-2">
                    <button type="button" onClick={() => setPickerOpen(false)} className="rounded px-3 py-1 text-sm font-semibold text-action hover:bg-pressed">
                      Done
                    </button>
                  </div>
                </div>
              )}

              {autoNote && picks.length === 1 && (
                <p role="status" className={`mt-1.5 text-sm ${autoNote.source === "ai" ? "text-[#6a3de8]" : "text-success"}`}>
                  {autoNote.source === "ai" ? (
                    <>
                      ✦ Suggested by AI: <strong>{autoNote.name}</strong>. Check it before saving.
                    </>
                  ) : (
                    <>
                      Picked <strong>{autoNote.name}</strong> based on last time.
                    </>
                  )}
                </p>
              )}
              {!splitting && picks[0] && type === "income" && picks[0].target.startsWith("l:") && (
                <p className="mt-1.5 text-sm text-subtle">Counts as money back on this item, like a refund or a transfer back into a fund. It lowers what's spent; it isn't income.</p>
              )}

              {/* Splitting: an amount per item */}
              {splitting && (
                <div className="mt-3 flex flex-col gap-2">
                  {picks.map((p) => (
                    <div key={p.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{nameOf(p.target)}</span>
                      <input
                        inputMode="decimal"
                        aria-label={`Amount for ${nameOf(p.target)}`}
                        placeholder="$0.00"
                        value={p.amount}
                        onChange={(e) => setPicks((all) => all.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)))}
                        className="tabular w-32 shrink-0 rounded-lg border border-muted/60 bg-white px-3 py-2 text-right outline-none focus:border-action focus:ring-2 focus:ring-action/15"
                      />
                      <button type="button" aria-label={`Remove ${nameOf(p.target)}`} onClick={() => togglePick(p.target)} className="rounded p-1 text-muted hover:text-error">
                        <Trash />
                      </button>
                    </div>
                  ))}
                  <p role="status" className={`tabular text-right text-sm ${leftToSplit === 0 ? "text-success" : "text-error"}`}>
                    {leftToSplit === 0 ? "All assigned" : leftToSplit > 0 ? `${formatCents(leftToSplit)} left to assign` : `${formatCents(-leftToSplit)} too much`}
                  </p>
                </div>
              )}
            </div>

            {/* More Options */}
            <div>
              <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} className="flex items-center gap-2 font-bold">
                More Options {moreOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {moreOpen && (
                <div className="mt-3 flex flex-col gap-4">
                  <label className="block font-bold">
                    Check #
                    <input aria-label="Check number" inputMode="numeric" placeholder="Check #" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} className={`${box} mt-2 font-normal`} />
                  </label>
                  <label className="block font-bold">
                    Note
                    <textarea aria-label="Note" placeholder="Note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${box} mt-2 resize-y font-normal`} />
                  </label>
                </div>
              )}
            </div>

            {error && <p role="alert" className="rounded-lg bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
          </div>

          <footer className="flex items-center gap-3 border-t border-line px-6 py-4">
            {existing && (
              <button
                type="button"
                disabled={busy}
                onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
                onBlur={() => setConfirmDelete(false)}
                className={`rounded px-2 py-2 font-semibold ${confirmDelete ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
              >
                {confirmDelete ? "Delete it" : "Delete"}
              </button>
            )}
            <span className="flex-1" />
            <button type="button" onClick={onCancel} className="rounded px-3 py-2 font-semibold text-action hover:bg-pressed">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="rounded-lg bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
              {existing ? "Save Changes" : `Add ${kind}`}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body
  );
}
