import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type GoalPlan, type SinkingFund } from "../api";
import { MONTH_NAMES } from "../dates";
import { centsToInput, formatCents, formatWholeDollars, parseMoney } from "../money";
import FundHistory, { AdjustmentForm } from "./FundHistory";
import { GoalIcon, PlusIcon } from "./Icons";
import { useLockBodyScroll } from "../scrollLock";

// Personal Goals: a target amount, the month to reach it by, and what's
// already saved. A new goal is added to this month's budget (a "Goals" line saving the monthly
// amount needed). Goals stop at their target; sinking funds (Funds page) can keep growing.

const monthName = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

function statusLine(g: SinkingFund) {
  const plan = g.plan as GoalPlan | null;
  if (g.goalReached) return { tone: "success", text: "🎉 Goal reached!" };
  if (!plan) return null;
  const left = `${formatCents(plan.neededCents)} to go`;
  if (plan.overdue) return { tone: "error", text: `${left} · the goal date (${monthName(g.targetDate!)}) has passed` };
  if (plan.monthlyCents) return { tone: "subtle", text: `Save ${formatCents(plan.monthlyCents)}/month to reach it by ${monthName(g.targetDate!)}` };
  return { tone: "subtle", text: left };
}

interface GoalFields {
  name: string;
  targetCents: number;
  targetDate: string | null; // YYYY-MM
  startingBalanceCents: number;
}

// The Add / Edit Goal panel
function GoalForm({ initial, onSave, onClose, onDelete }: { initial?: SinkingFund; onSave: (f: GoalFields) => Promise<void>; onClose: () => void; onDelete?: () => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial?.targetCents ? centsToInput(initial.targetCents) : "");
  const [month, setMonth] = useState(initial?.targetDate ? String(Number(initial.targetDate.slice(5, 7))) : "");
  const [year, setYear] = useState(initial?.targetDate ? initial.targetDate.slice(0, 4) : "");
  const [starting, setStarting] = useState(initial?.startingBalanceCents ? centsToInput(initial.startingBalanceCents) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const thisYear = new Date().getFullYear();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const targetCents = parseMoney(amount);
    const startingCents = starting.trim() ? parseMoney(starting) : 0;
    if (!name.trim()) return setError("Give the goal a name");
    if (!targetCents) return setError("Enter the goal amount");
    if (startingCents === null || startingCents < 0) return setError("Starting balance isn't a valid amount");
    if (!!month !== !!year) return setError("Pick both a month and a year (or neither)");
    setBusy(true);
    setError("");
    try {
      await onSave({ name: name.trim(), targetCents, targetDate: month && year ? `${year}-${month.padStart(2, "0")}` : null, startingBalanceCents: startingCents });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
  const row = "flex items-start justify-between gap-3 border-b border-line py-5";
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()} aria-label={initial ? `Edit ${initial.name}` : "Add Goal"} className="rounded-2xl bg-white">
      <div className="relative flex items-center justify-center border-b border-line px-5 py-5">
        <h2 className="text-xl font-bold">{initial ? "Edit Goal" : "Add Goal"}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 flex size-8 items-center justify-center rounded-full bg-page text-action hover:bg-pressed">
          ✕
        </button>
      </div>
      <div className="px-4">
        <label className="block border-b border-line py-5">
          <span className="font-semibold">Name</span>
          <input autoFocus aria-label="Goal name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Emergency fund, New car" className={`${input} mt-2`} />
        </label>
        <div className={row}>
          <div>
            <div className="font-semibold">Target</div>
            <div className="text-sm text-subtle">How much you need in the end</div>
          </div>
          <input aria-label="Goal amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" className={`${input} tabular w-32 text-right`} />
        </div>
        <div className={row}>
          <div>
            <div className="font-semibold">Reach it by</div>
            <div className="text-sm text-subtle">Optional. We'll work out a monthly amount.</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <select aria-label="Goal month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${input} w-[5.5rem] px-2`}>
              <option value="">Month</option>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m.slice(0, 3)}
                </option>
              ))}
            </select>
            <select aria-label="Goal year" value={year} onChange={(e) => setYear(e.target.value)} className={`${input} w-[5.5rem] px-2`}>
              <option value="">Year</option>
              {Array.from({ length: 31 }, (_, i) => thisYear + i).map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={`${row} border-b-0`}>
          <div>
            <div className="font-semibold">Already saved</div>
            <div className="text-sm text-subtle">What you have toward it today</div>
          </div>
          <input aria-label="Starting balance" inputMode="decimal" value={starting} onChange={(e) => setStarting(e.target.value)} placeholder="$0.00" className={`${input} tabular w-32 text-right`} />
        </div>
        {error && <p role="alert" className="mb-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-3 px-4 pb-4">
        {onDelete && (
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`mr-auto rounded px-3 py-2 text-sm font-semibold ${confirmDelete ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
          >
            {confirmDelete ? "Delete for good?" : "Delete"}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded px-4 py-3 font-semibold text-action hover:bg-pressed">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="rounded bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-50">
          {initial ? "Save" : "Add Goal"}
        </button>
      </div>
      {!initial && <p className="px-4 pb-5 text-right text-subtle">A monthly line for it goes into this month's budget.</p>}
    </form>
  );
}

function GoalCard({ goal, onEdit, onChanged, onArchive }: { goal: SinkingFund; onEdit: () => void; onChanged: () => Promise<void>; onArchive: (a: boolean) => void }) {
  const [showHistory, setShowHistory] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = async () => {
    await onChanged();
    setVersion((v) => v + 1);
  };
  const target = goal.targetCents ?? 0;
  const pct = target ? Math.min(100, Math.max(0, Math.round((goal.balanceCents / target) * 100))) : 0;
  const status = statusLine(goal);
  return (
    <article aria-label={goal.name} className={`rounded-2xl bg-white p-5 ${goal.archived ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-4">
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-full ${goal.goalReached ? "bg-success-subtle text-success" : "bg-pressed text-primary"}`}>
          <GoalIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold">
            {goal.name}
            {goal.archived && <span className="ml-2 rounded bg-page px-2 py-0.5 text-xs font-normal text-subtle">Archived</span>}
          </h2>
          <div className="tabular text-xl font-semibold sm:text-2xl">
            {formatCents(goal.balanceCents)}
            <span className="whitespace-nowrap text-sm font-normal text-subtle sm:text-base"> of {formatCents(target)}</span>
          </div>
          {goal.targetDate && <div className="text-sm text-subtle">Goal date: {monthName(goal.targetDate)}</div>}
        </div>
        <span className={`tabular text-lg font-bold ${goal.goalReached ? "text-success" : "text-primary"}`}>{pct}%</span>
      </div>
      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-page" role="progressbar" aria-label={`${goal.name} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-all ${goal.goalReached ? "bg-success" : "bg-brand"}`} style={{ width: `${pct}%` }} />
      </div>
      {status && <p className={`mt-3 text-sm font-medium ${status.tone === "success" ? "text-success" : status.tone === "error" ? "text-error" : "text-subtle"}`}>{status.text}</p>}

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold">
        {!goal.goalReached && (
          <button onClick={() => setAdjusting((a) => !a)} className="text-link hover:underline">
            Add / take out
          </button>
        )}
        <button onClick={() => setShowHistory((h) => !h)} aria-expanded={showHistory} className="text-link hover:underline">
          {showHistory ? "Hide history" : "History"}
        </button>
        <button onClick={onEdit} className="text-link hover:underline">Edit</button>
        <button onClick={() => onArchive(!goal.archived)} className="text-subtle hover:underline">
          {goal.archived ? "Restore" : "Archive"}
        </button>
      </div>
      {adjusting && (
        <AdjustmentForm
          fundId={goal.id}
          onCancel={() => setAdjusting(false)}
          onDone={async () => {
            setAdjusting(false);
            setShowHistory(true);
            await refresh();
          }}
        />
      )}
      {showHistory && <FundHistory fundId={goal.id} version={version} onChanged={refresh} />}
    </article>
  );
}

export default function GoalsPage() {
  const [funds, setFunds] = useState<SinkingFund[] | null>(null);
  const [panel, setPanel] = useState<{ kind: "add" } | { kind: "edit"; goal: SinkingFund } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // On phones the panel is a popup
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 767px)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 767px)");
    const on = () => setNarrow(mq.matches);
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, []);
  useLockBodyScroll(!!panel && narrow);

  const load = useCallback(async () => {
    setFunds(await api<SinkingFund[]>("GET", `/api/funds?includeArchived=${showArchived}`));
  }, [showArchived]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const goals = (funds ?? []).filter((f) => f.kind === "goal");
  const totalSaved = goals.filter((g) => !g.archived).reduce((t, g) => t + Math.max(0, g.balanceCents), 0);

  async function add(f: GoalFields) {
    const r = await api<{ addedTo: { year: number; month: number; plannedCents: number; groupName: string } | null; plan: GoalPlan }>("POST", "/api/goals", f);
    setPanel(null);
    setNotice(
      r.addedTo
        ? `Added to your ${MONTH_NAMES[r.addedTo.month - 1]} budget under ${r.addedTo.groupName}: ${formatCents(r.addedTo.plannedCents)} this month.`
        : f.targetDate
          ? "Goal added. This month's budget isn't open, so link a budget item to it when you're ready."
          : "Goal added. Pick a goal date to see how much to save each month."
    );
    await load();
  }

  const panelEl = panel && (
    <GoalForm
      key={panel.kind === "edit" ? panel.goal.id : "add"}
      initial={panel.kind === "edit" ? panel.goal : undefined}
      onClose={() => setPanel(null)}
      onSave={
        panel.kind === "add"
          ? add
          : async (f) => {
              await api("PATCH", `/api/funds/${panel.goal.id}`, f);
              setPanel(null);
              await load();
            }
      }
      onDelete={
        panel.kind === "edit"
          ? async () => {
              await api("DELETE", `/api/funds/${panel.goal.id}`);
              setPanel(null);
              await load();
            }
          : undefined
      }
    />
  );

  return (
    <div className="mx-auto max-w-[1100px] px-3 pb-16 pt-8 sm:px-6">
      <h1 className="text-4xl font-bold">Savings Goals</h1>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-lg text-subtle">Choose a target and a date, and we'll work out how much to set aside each month.</p>
        <label className="flex items-center gap-2 text-sm text-subtle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-action" />
          Show archived
        </label>
      </div>
      {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-error">{error}</p>}
      {notice && (
        <p role="status" className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-brand-subtle px-4 py-3 text-success">
          {notice}
          <button onClick={() => setNotice("")} aria-label="Dismiss" className="text-subtle">✕</button>
        </p>
      )}

      <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <button onClick={() => setPanel({ kind: "add" })} className={`flex items-center gap-4 rounded-2xl p-4 text-left ${panel?.kind === "add" ? "bg-pressed" : "bg-white hover:bg-pressed"}`}>
            <span className="flex size-12 items-center justify-center rounded-full bg-page text-action">
              <PlusIcon />
            </span>
            <span className="text-lg font-semibold text-action">Add Goal</span>
          </button>
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onEdit={() => setPanel({ kind: "edit", goal: g })}
              onChanged={load}
              onArchive={(archived) => api("PATCH", `/api/funds/${g.id}`, { archived }).then(load).catch((e) => setError(e.message))}
            />
          ))}
          {funds && goals.length === 0 && <p className="px-2 text-subtle">No goals yet. An emergency fund, a down payment, a new car — what are you saving for?</p>}
        </div>

        <aside className="w-full shrink-0 md:sticky md:top-6 md:w-[300px]">
          {panel && !narrow ? (
            panelEl
          ) : (
            <section aria-label="Total saved so far" className="rounded-2xl bg-white p-4">
              <h2 className="text-lg font-semibold">Saved toward goals</h2>
              <div className="tabular text-4xl font-semibold text-subtle">{totalSaved % 100 === 0 ? formatWholeDollars(totalSaved) : formatCents(totalSaved)}</div>
              <p className="mt-1 text-sm text-subtle">Everything set aside across your goals.</p>
            </section>
          )}
        </aside>
      </div>

      {panel && narrow && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2" onClick={(e) => e.target === e.currentTarget && setPanel(null)}>
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl">{panelEl}</div>
        </div>
      )}
    </div>
  );
}
