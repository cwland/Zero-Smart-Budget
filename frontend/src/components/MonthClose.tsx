import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Budget, type CloseChoice, type MonthClosePreview, type MonthCloseResult } from "../api";
import { MONTH_NAMES } from "../dates";
import { formatCents } from "../money";
import { useLockBodyScroll } from "../scrollLock";
import { CloseIcon, PiggyIcon } from "./Icons";

// Month Wrap-Up: from 4 days before the end of a month (and on any past month
// that's still open), review what's left and what's overspent, then give the leftover ONE job:
// a goal or sinking fund, or roll it over to next month. If you're over, cover it from one fund.


// One line saying what a close did
export function resultSummary(r: MonthCloseResult, monthName: string, nextName: string) {
  if (r.totalCents === 0) return "Every dollar was spent as planned.";
  if (r.leftover) {
    const l = r.leftover;
    if (l.to === "fund") return `${formatCents(l.amountCents)} went to ${l.fundName}${l.keptCents ? `; ${formatCents(l.keptCents)} stayed in ${monthName}` : ""}.`;
    if (l.to === "rollover") return `${formatCents(l.amountCents)} rolled over to ${nextName}.`;
    return `${formatCents(l.keptCents)} left over stayed in ${monthName}.`;
  }
  if (r.overspent) {
    const o = r.overspent;
    if (o.to === "fund") return `${formatCents(o.amountCents)} came out of ${o.fundName} to cover overspending${o.uncoveredCents ? `; ${formatCents(o.uncoveredCents)} wasn't covered` : ""}.`;
    return `Overspent by ${formatCents(o.uncoveredCents)}.`;
  }
  return "";
}

// Is this budget for a month that's already over?
const isPast = (b: { year: number; month: number }) => {
  const now = new Date();
  return b.year * 12 + b.month < now.getFullYear() * 12 + now.getMonth() + 1;
};

const nextMonthName = (b: { year: number; month: number }) => (b.month === 12 ? MONTH_NAMES[0] : MONTH_NAMES[b.month]);

// The card at the top of the budget
export function MonthCloseBanner({ budget, onOpen, onReopen }: { budget: Budget; onOpen: () => void; onReopen: () => Promise<void> }) {
  const c = budget.close;
  const [busy, setBusy] = useState(false);
  const name = MONTH_NAMES[budget.month - 1];
  if (!c) return null;

  if (c.closed) {
    return (
      <section aria-label="Month wrapped up" className="mb-6 rounded-2xl bg-white p-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-page px-3 py-1 text-sm font-semibold text-subtle">🔒 Wrapped up</span>
          <p className="min-w-0 flex-1 text-subtle">
            {c.closedBy === "auto" ? `${name} was wrapped up automatically.` : `You wrapped up ${name}.`} {c.result && resultSummary(c.result, name, nextMonthName(budget))}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onReopen().finally(() => setBusy(false));
            }}
            className="rounded border border-action px-4 py-2 font-semibold text-action hover:bg-pressed disabled:opacity-50"
          >
            Reopen {name}
          </button>
        </div>
        {c.changedSinceClose && (
          <p role="status" className="mt-3 rounded-lg bg-[#fff4dc] px-3 py-2 text-sm text-ink">
            Transactions changed after you wrapped up {name}, so the numbers are different now. Reopen it and wrap it up again to update where the money went.
          </p>
        )}
        <p className="mt-2 text-sm text-muted">The plan is locked while it's wrapped up. Transactions can still be added.</p>
      </section>
    );
  }

  if (!c.available) return null;
  return (
    <section aria-label="Month Wrap-Up" className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl bg-primary p-4 text-white sm:px-6">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-bold">{budget.close.available && isPast(budget) ? `${name} hasn't been wrapped up yet` : `${name} is almost over`}</h2>
        <p className="text-white/80">See where you came out ahead or went over, and decide where any extra money goes.</p>
      </div>
      <button onClick={onOpen} className="rounded bg-white px-5 py-2.5 font-semibold text-primary hover:bg-pressed">
        Wrap Up {name}
      </button>
    </section>
  );
}

type Choice = "fund" | "rollover" | "keep";

function Lines({ title, lines, tone }: { title: string; lines: { id: number; name: string; group: string; remainingCents: number }[]; tone: "good" | "bad" }) {
  if (!lines.length) return null;
  const total = lines.reduce((n, l) => n + l.remainingCents, 0);
  return (
    <section aria-label={title} className="mt-5">
      <h3 className="flex items-center justify-between text-sm font-semibold uppercase tracking-wide text-subtle">
        <span>
          {title} ({lines.length})
        </span>
        <span className={`tabular ${tone === "good" ? "text-success" : "text-error"}`}>{formatCents(Math.abs(total))}</span>
      </h3>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
        {lines.map((l) => (
          <li key={l.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{l.name}</span>
              <span className="block text-xs text-subtle">{l.group}</span>
            </span>
            <span className={`tabular font-medium ${tone === "good" ? "text-success" : "text-error"}`}>
              {tone === "bad" ? "−" : ""}
              {formatCents(Math.abs(l.remainingCents))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MonthCloseDialog({ monthId, onClose, onDone }: { monthId: number; onClose: () => void; onDone: () => Promise<void> }) {
  useLockBodyScroll();
  const [p, setP] = useState<MonthClosePreview | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Choice>("fund");
  const [fundId, setFundId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MonthCloseResult | null>(null);

  useEffect(() => {
    api<MonthClosePreview>("GET", `/api/months/${monthId}/close`)
      .then((preview) => {
        setP(preview);
        // Start from what the last close did (after a reopen)
        const r = preview.result;
        if (r?.leftover) {
          setChoice(r.leftover.to);
          if (r.leftover.fundId) setFundId(r.leftover.fundId);
        } else if (r?.overspent) {
          setChoice(r.overspent.to === "fund" ? "fund" : "keep");
          if (r.overspent.fundId) setFundId(r.overspent.fundId);
        }
      })
      .catch((e) => setError(e.message));
  }, [monthId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const under = (p?.totalCents ?? 0) > 0;
  const over = (p?.totalCents ?? 0) < 0;
  const amount = Math.abs(p?.totalCents ?? 0);
  // Goals first, then sinking funds
  const funds = useMemo(() => [...(p?.funds ?? [])].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "goal" ? -1 : 1)), [p]);
  const picked = funds.find((f) => f.id === fundId);
  const short = p ? p.name.split(" ")[0] : "";
  const nextShort = p ? p.nextName.split(" ")[0] : "";

  // What picking this fund will do
  let note = "";
  if (p && picked && choice === "fund") {
    if (under && picked.roomCents !== null && picked.roomCents < amount) {
      note = `${picked.name} only needs ${formatCents(picked.roomCents)} to reach its goal. The other ${formatCents(amount - picked.roomCents)} stays in ${short}.`;
    }
    if (over && picked.balanceCents < amount) {
      note = `${picked.name} has ${formatCents(Math.max(0, picked.balanceCents))}, so ${formatCents(amount - Math.max(0, picked.balanceCents))} stays overspent.`;
    }
  }

  async function submit() {
    if (!p) return;
    let body: CloseChoice = {};
    if (under || over) {
      if (choice === "fund") {
        if (!fundId) return setError(`Pick a ${under ? "goal or fund" : "fund or goal"}`);
        body = under ? { leftover: { to: "fund", fundId } } : { overspent: { to: "fund", fundId } };
      } else if (choice === "rollover" && under) body = { leftover: { to: "rollover" } };
      else body = under ? { leftover: { to: "keep" } } : { overspent: { to: "keep" } };
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{ result: MonthCloseResult }>("POST", `/api/months/${p.id}/close`, body);
      setDone(r.result);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const option = (value: Choice, label: string, sub: string) => (
    <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${choice === value ? "border-action bg-pressed" : "border-line hover:bg-page"}`}>
      <input type="radio" name="close-choice" checked={choice === value} onChange={() => setChoice(value)} className="mt-1 size-4 accent-[#0073b9]" />
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-sm text-subtle">{sub}</span>
      </span>
    </label>
  );

  const title = p ? `Wrap up ${p.name}` : "Month Wrap-Up";
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[94vh] w-full max-w-[34rem] flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_12px_40px_rgba(31,36,38,0.3)] sm:rounded-2xl">
        <header className="relative flex items-center justify-center bg-page px-12 py-5">
          <h2 className="text-xl font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1.5 text-subtle hover:bg-white/70 hover:text-ink">
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 sm:px-6">
          {!p && !error && <p className="py-10 text-center text-subtle">Loading…</p>}

          {p && done && (
            <div className="py-8 text-center">
              <div className="text-5xl">🎉</div>
              <h3 className="mt-3 text-2xl font-bold">{short} is wrapped up</h3>
              <p className="mt-2 text-subtle">{resultSummary(done, short, nextShort)}</p>
              {done.leftover?.to === "rollover" && !p.nextExists && <p className="mt-2 text-sm text-subtle">It'll show up as income when you create {nextShort}'s budget.</p>}
            </div>
          )}

          {p && !done && (
            <>
              {p.uncategorized > 0 && (
                <p role="status" className="mt-5 rounded-lg bg-[#fff4dc] px-3 py-2 text-sm">
                  {p.uncategorized} transaction{p.uncategorized === 1 ? " isn't" : "s aren't"} tracked yet in {short}. Track everything first so the numbers are right.
                </p>
              )}

              {/* The month total */}
              <section aria-label="Month total" className={`mt-5 rounded-xl p-4 text-center ${under ? "bg-success-subtle" : over ? "bg-error-subtle" : "bg-page"}`}>
                <div className="text-sm font-semibold uppercase tracking-wide text-subtle">{p.name}</div>
                <div className={`tabular mt-1 text-3xl font-bold ${under ? "text-success" : over ? "text-error" : ""}`}>
                  {under ? `${formatCents(amount)} under budget` : over ? `${formatCents(amount)} over budget` : "Right on budget"}
                </div>
                <div className="mt-1 text-sm text-subtle">
                  Income received {formatCents(p.income.receivedCents)}
                  {p.income.receivedCents !== p.income.plannedCents ? ` (planned ${formatCents(p.income.plannedCents)})` : ""}
                </div>
              </section>

              <Lines title="Money left" lines={p.moneyLeft} tone="good" />
              <Lines title="Overspent" lines={p.overspent} tone="bad" />
              {p.fundItems.length > 0 && (
                <p className="mt-4 text-sm text-subtle">
                  <PiggyIcon className="mr-1 inline size-4 align-text-bottom" />
                  {p.fundItems.map((f) => f.name).join(", ")} {p.fundItems.length === 1 ? "is" : "are"} linked to a fund or goal, so what's left (or overspent) stays there.
                </p>
              )}
              {p.leftToBudgetCents !== 0 && (
                <p className="mt-2 text-sm text-subtle">
                  {p.leftToBudgetCents > 0 ? `${formatCents(p.leftToBudgetCents)} of planned income was never given a job.` : `The plan was ${formatCents(-p.leftToBudgetCents)} more than the income.`}
                </p>
              )}

              {(under || over) && (
                <fieldset className="mt-6">
                  <legend className="text-lg font-bold">{under ? `What should the ${formatCents(amount)} do?` : `Cover the ${formatCents(amount)}?`}</legend>
                  <div className="mt-3 flex flex-col gap-2">
                    {option("fund", under ? "Put it toward a goal or fund" : "Cover it from a fund or goal", under ? "All of it goes to one goal or sinking fund." : "Take it out of one fund or goal.")}
                    {choice === "fund" && (
                      <div className="ml-7">
                        <select
                          aria-label={under ? "Goal or fund to put it in" : "Fund to cover it from"}
                          value={fundId}
                          onChange={(e) => setFundId(e.target.value ? Number(e.target.value) : "")}
                          className="w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15"
                        >
                          <option value="">{funds.length ? "Choose one…" : "No funds or goals yet"}</option>
                          {funds.map((f) => {
                            const full = under && f.goalReached;
                            const empty = over && f.balanceCents <= 0;
                            return (
                              <option key={f.id} value={f.id} disabled={full || empty}>
                                {f.kind === "goal" ? "🎯 " : "🐷 "}
                                {f.name} · {formatCents(f.balanceCents)}
                                {f.targetCents ? ` of ${formatCents(f.targetCents)}` : ""}
                                {full ? " (goal reached)" : empty ? " (empty)" : ""}
                              </option>
                            );
                          })}
                        </select>
                        {note && <p className="mt-2 text-sm text-subtle">{note}</p>}
                        {!funds.length && (
                          <p className="mt-2 text-sm text-subtle">
                            Make one on the <a href="#/goals" onClick={onClose} className="font-semibold text-link hover:underline">Goals</a> or <a href="#/funds" onClick={onClose} className="font-semibold text-link hover:underline">Funds</a> page.
                          </p>
                        )}
                      </div>
                    )}
                    {under && option("rollover", `Roll it over to ${nextShort}`, `Adds “Rollover from ${short}” to ${nextShort}'s income${p.nextExists ? "" : " when you create that budget"}.`)}
                    {option("keep", under ? `Leave it in ${short}` : "Leave it as is", under ? "Nothing moves." : "The overspending stays in this month.")}
                  </div>
                </fieldset>
              )}
            </>
          )}
          {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-line px-5 py-4 sm:px-6">
          {done ? (
            <button onClick={onClose} className="rounded bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed">
              Done
            </button>
          ) : (
            <>
              <button onClick={onClose} className="rounded px-4 py-3 font-semibold text-action hover:bg-pressed">
                Cancel
              </button>
              <button disabled={!p || busy} onClick={submit} className="rounded bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-50">
                Finish Wrap-Up
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}

