import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type SinkingFund } from "../api";
import { centsToInput, formatCents, parseMoney } from "../money";
import FundHistory, { AdjustmentForm } from "./FundHistory";
import { PiggyIcon } from "./Icons";
import { ProgressBar } from "./ItemRow";

interface FundFields {
  name: string;
  targetCents: number | null;
  startingBalanceCents: number;
}

// Add / edit form for one fund
function FundForm({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial?: SinkingFund;
  onSave: (f: FundFields) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [target, setTarget] = useState(initial?.targetCents ? centsToInput(initial.targetCents) : "");
  const [starting, setStarting] = useState(initial?.startingBalanceCents ? centsToInput(initial.startingBalanceCents) : "");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const targetCents = target.trim() ? parseMoney(target) : null;
    const startingCents = parseMoney(starting);
    if (!name.trim()) return setError("Give the fund a name");
    if (target.trim() && targetCents === null) return setError("Target isn't a valid amount");
    if (startingCents === null) return setError("Starting balance isn't a valid amount");
    try {
      await onSave({ name: name.trim(), targetCents: targetCents || null, startingBalanceCents: startingCents });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()} aria-label={initial ? `Edit ${initial.name}` : "New fund"} className="flex flex-col gap-3">
      <label className="text-sm font-medium text-subtle">
        Name
        <input autoFocus aria-label="Fund name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Car repairs, Vacation, Christmas…" className={field} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm font-medium text-subtle">
          Target <span className="font-normal text-muted">(optional)</span>
          <input aria-label="Target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="$0.00" className={`${field} tabular`} />
        </label>
        <label className="text-sm font-medium text-subtle">
          Already saved
          <input aria-label="Starting balance" inputMode="decimal" value={starting} onChange={(e) => setStarting(e.target.value)} placeholder="$0.00" className={`${field} tabular`} />
        </label>
      </div>
      {error && <p role="alert" className="rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" className="rounded bg-primary px-5 py-2.5 font-semibold text-white hover:bg-primary-pressed">
          {initial ? "Save" : "Add Fund"}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-4 py-2.5 font-semibold text-action hover:bg-pressed">
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`ml-auto rounded px-3 py-2 text-sm font-semibold ${confirmDelete ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
          >
            {confirmDelete ? "Delete for good?" : "Delete"}
          </button>
        )}
      </div>
      {onDelete && confirmDelete && (
        <p className="text-sm text-subtle">Deleting unlinks its budget items. Their planned amounts and transactions stay.</p>
      )}
    </form>
  );
}

function FundCard({ fund, onEdit, onArchive, onChanged }: { fund: SinkingFund; onEdit: () => void; onArchive: (archived: boolean) => void; onChanged: () => Promise<void> }) {
  const [showHistory, setShowHistory] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = async () => {
    await onChanged();
    setVersion((v) => v + 1);
  };
  const adjusted = fund.adjustmentsCents + (fund.monthCloseCents ?? 0);
  const pct = fund.targetCents ? Math.min(100, Math.round((fund.balanceCents / fund.targetCents) * 100)) : null;
  return (
    <article aria-label={fund.name} className={`rounded-2xl bg-white p-5 ${fund.archived ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-success">
          <PiggyIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">
            {fund.name}
            {fund.archived && <span className="ml-2 rounded bg-page px-2 py-0.5 text-xs font-normal text-subtle">Archived</span>}
          </h2>
          <div className="tabular text-2xl font-semibold">
            <span className={fund.balanceCents < 0 ? "text-error" : ""}>{formatCents(fund.balanceCents)}</span>
            {fund.targetCents ? <span className="text-base font-normal text-subtle"> of {formatCents(fund.targetCents)}</span> : null}
          </div>
        </div>
        {pct !== null && <span className="tabular text-sm font-semibold text-success">{pct}%</span>}
      </div>

      {fund.targetCents ? (
        <div className="mt-3">
          <ProgressBar actual={Math.max(0, fund.balanceCents)} planned={fund.targetCents} />
        </div>
      ) : null}

      <dl className="tabular mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg bg-page px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-subtle">Starting</dt>
          <dd>{formatCents(fund.startingBalanceCents)}</dd>
        </div>
        <div className="rounded-lg bg-page px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-subtle">Budgeted</dt>
          <dd className="text-success">+{formatCents(fund.contributedCents)}</dd>
        </div>
        <div className="rounded-lg bg-page px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-subtle">Spent</dt>
          <dd className={fund.spentCents > 0 ? "text-error" : fund.spentCents < 0 ? "text-success" : ""}>
            {fund.spentCents > 0 ? "−" : fund.spentCents < 0 ? "+" : ""}
            {formatCents(Math.abs(fund.spentCents))}
          </dd>
        </div>
        <div className="rounded-lg bg-page px-3 py-2">
          <dt className="text-xs uppercase tracking-wide text-subtle">Adjusted</dt>
          {/* By hand, plus leftovers put in / overspends covered at Month Close */}
          <dd className={adjusted < 0 ? "text-error" : adjusted > 0 ? "text-success" : ""}>
            {adjusted > 0 ? "+" : adjusted < 0 ? "−" : ""}
            {formatCents(Math.abs(adjusted))}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold">
        <button onClick={() => setAdjusting((a) => !a)} className="text-link hover:underline">
          Add / take out
        </button>
        <button onClick={() => setShowHistory((h) => !h)} aria-expanded={showHistory} className="text-link hover:underline">
          {showHistory ? "Hide history" : "History"}
        </button>
        <button onClick={onEdit} className="text-link hover:underline">Edit</button>
        <button onClick={() => onArchive(!fund.archived)} className="text-subtle hover:underline">
          {fund.archived ? "Restore" : "Archive"}
        </button>
      </div>

      {adjusting && (
        <AdjustmentForm
          fundId={fund.id}
          onCancel={() => setAdjusting(false)}
          onDone={async () => {
            setAdjusting(false);
            setShowHistory(true);
            await refresh();
          }}
        />
      )}
      {showHistory && <FundHistory fundId={fund.id} version={version} onChanged={refresh} />}
    </article>
  );
}

export default function FundsPage() {
  const [funds, setFunds] = useState<SinkingFund[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const list = await api<SinkingFund[]>("GET", `/api/funds?includeArchived=${showArchived}`);
    if (seq === loadSeq.current) setFunds(list.filter((f) => f.kind !== "goal")); // goals have their own page; ignore out-of-order answers
  }, [showArchived]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const totalBalance = (funds ?? []).filter((f) => !f.archived).reduce((t, f) => t + f.balanceCents, 0);

  return (
    <div className="mx-auto max-w-[900px] px-3 pb-16 pt-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <h1 className="text-2xl font-semibold">Sinking Funds</h1>
        <label className="flex items-center gap-2 text-sm text-subtle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[#0073b9]" />
          Show archived
        </label>
      </div>

      <div className="mt-4 flex h-[46px] items-center justify-center rounded-2xl bg-white px-4 text-lg shadow-[0_4px_12px_rgba(31,36,38,0.06)]">
        <span>
          <span className="tabular font-medium text-success">{formatCents(totalBalance)}</span> saved across your funds
        </span>
      </div>

      <p className="mt-4 text-sm text-subtle">
        Sinking funds save up for things you know are coming, like car repairs or Christmas, and can keep growing. Link a budget item to a fund (click the item on your budget): what you plan for it each month is added, and spending on it comes out. Saving toward a set amount? Use <a href="#/goals" className="font-semibold text-link hover:underline">Goals</a> instead.
      </p>

      {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-error">{error}</p>}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {adding ? (
          <div className="rounded-2xl bg-white p-5">
            <FundForm
              onCancel={() => setAdding(false)}
              onSave={async (f) => {
                await api("POST", "/api/funds", f);
                setAdding(false);
                await load();
              }}
            />
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="min-h-32 self-start rounded-2xl border-2 border-dotted border-strong p-6 font-semibold text-action hover:bg-white"
          >
            Add Fund
          </button>
        )}

        {funds?.map((f) =>
          editingId === f.id ? (
            <div key={f.id} className="rounded-2xl bg-white p-5">
              <FundForm
                initial={f}
                onCancel={() => setEditingId(null)}
                onSave={async (changes) => {
                  await api("PATCH", `/api/funds/${f.id}`, changes);
                  setEditingId(null);
                  await load();
                }}
                onDelete={async () => {
                  await api("DELETE", `/api/funds/${f.id}`);
                  setEditingId(null);
                  await load();
                }}
              />
            </div>
          ) : (
            <FundCard
              key={f.id}
              fund={f}
              onEdit={() => setEditingId(f.id)}
              onChanged={load}
              onArchive={(archived) =>
                api("PATCH", `/api/funds/${f.id}`, { archived })
                  .then(load)
                  .catch((e) => setError(e.message))
              }
            />
          )
        )}
      </div>

      {funds && funds.length === 0 && !adding && (
        <p className="mt-6 text-center text-subtle">No funds yet. Add one for things like car repairs, vacations or Christmas.</p>
      )}
    </div>
  );
}
