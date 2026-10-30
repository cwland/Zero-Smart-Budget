import { useTheme } from "../themes";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Budget, type MonthResponse, type Transaction } from "../api";
import { monthLabel } from "../dates";
import { useLockBodyScroll } from "../scrollLock";
import ItemDetail, { type ItemRef } from "./ItemDetail";
import TransactionForm, { type FormPreset } from "./TransactionForm";
import TransactionList from "./TransactionList";
import { formatCents, formatWholeDollars } from "../money";
import { PieIcon } from "./Icons";

// One color per group, in order

type Metric = "planned" | "spent" | "remaining";

function Donut({ values, colors, centerLabel, centerValue }: { values: number[]; colors: string[]; centerLabel: string; centerValue: string }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const total = values.reduce((t, v) => t + Math.max(0, v), 0);
  let offset = 0;

  return (
    <div className="relative mx-auto size-48">
      <svg viewBox="0 0 180 180" className="size-full -rotate-90">
        <circle cx="90" cy="90" r={r} fill="none" stroke="var(--color-line)" strokeWidth="18" />
        {total > 0 &&
          values.map((v, i) => {
            const len = (Math.max(0, v) / total) * c;
            const seg = (
              <circle
                key={i}
                cx="90"
                cy="90"
                r={r}
                fill="none"
                stroke={colors[i]}
                strokeWidth="18"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return seg;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm uppercase tracking-wide text-subtle">{centerLabel}</span>
        <span className="tabular text-2xl font-semibold">{centerValue}</span>
      </div>
    </div>
  );
}

export function SummaryChart({ budget }: { budget: Budget }) {
  const [metric, setMetric] = useState<Metric>("planned");
  const groupColors = useTheme().groups; // each group's color comes from the theme

  const income = budget.totals.incomePlannedCents;
  const colors = budget.groups.map((_, i) => groupColors[i % groupColors.length]);
  const valueOf = (g: Budget["groups"][number]) =>
    metric === "planned" ? g.plannedCents : metric === "spent" ? g.spentCents : g.remainingCents;
  const values = budget.groups.map(valueOf);
  const centerValue =
    metric === "planned" ? income : metric === "spent" ? budget.totals.spentCents : budget.totals.remainingCents;

  return (
    <>
      <div className="py-6">
        <Donut
          values={values}
          colors={colors}
          centerLabel={metric === "planned" ? "Income" : metric}
          centerValue={formatWholeDollars(centerValue)}
        />
      </div>

      <div role="tablist" className="mx-2 grid grid-cols-3 text-center text-sm font-semibold uppercase">
        {(["planned", "spent", "remaining"] as Metric[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={metric === m}
            onClick={() => setMetric(m)}
            className={`border-b-[3px] pb-2 uppercase ${metric === m ? "border-subtle text-ink" : "border-strong font-normal text-subtle"}`}
          >
            {m}
          </button>
        ))}
      </div>

      <ul className="mx-2 divide-y divide-line">
        {budget.groups.map((g, i) => {
          const v = valueOf(g);
          const pct = income > 0 ? Math.round((v / income) * 100) : 0;
          return (
            <li key={g.id} className="flex items-center gap-3 py-3">
              <span className="min-w-0 flex-1 truncate font-semibold" style={{ color: colors[i] }}>
                {g.name}
              </span>
              <span className={`tabular ${v < 0 ? "text-error" : ""}`}>{formatCents(v)}</span>
              <span className="tabular w-12 text-right text-subtle">({pct}%)</span>
            </li>
          );
        })}
        {budget.groups.length === 0 && <li className="py-6 text-center text-subtle">No groups yet</li>}
      </ul>
    </>
  );
}

// The transaction editor offers the items of the transaction's own month. Opening one from an
// earlier month (from the transactions list) loads that month's budget first.
function FormForMonth(props: { budget: Budget; existing?: Transaction; preset?: FormPreset; onCancel: () => void; onSaved: () => void }) {
  const { budget, existing } = props;
  const ym = existing ? { year: Number(existing.date.slice(0, 4)), month: Number(existing.date.slice(5, 7)) } : { year: budget.year, month: budget.month };
  const sameMonth = ym.year === budget.year && ym.month === budget.month;
  const [other, setOther] = useState<MonthResponse | null>(null);
  useLockBodyScroll(!sameMonth); // the notice/loading popups (the form itself locks too)
  const [error, setError] = useState("");

  useEffect(() => {
    if (sameMonth) return;
    api<MonthResponse>("GET", `/api/months/${ym.year}/${ym.month}`)
      .then(setOther)
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sameMonth, ym.year, ym.month]);

  if (sameMonth) return <TransactionForm {...props} />;
  if (error) return createPortal(<div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" onMouseDown={props.onCancel}><p role="alert" className="rounded-2xl bg-white p-6 text-error">{error}</p></div>, document.body);
  if (!other) return createPortal(<div className="fixed inset-0 z-[60] bg-ink/40" aria-busy="true" />, document.body);
  if (!other.exists) {
    return createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
        <div role="dialog" aria-modal="true" aria-label="No budget for this month" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-[0_12px_40px_rgba(31,36,38,0.3)]">
          <p className="font-semibold">{existing?.merchant}</p>
          <p className="mt-2 text-subtle">
            This transaction is in {monthLabel(ym)}, which has no budget yet. Create the {monthLabel(ym)} budget (use the arrows at the top) to assign it.
          </p>
          <div className="mt-5 flex justify-end">
            <button onClick={props.onCancel} className="rounded-lg bg-primary px-5 py-2.5 font-semibold text-white hover:bg-primary-pressed">
              OK
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }
  return <TransactionForm {...props} budget={other} />;
}

export type PanelView =
  | { kind: "summary" }
  | { kind: "transactions" }
  | { kind: "item"; item: ItemRef }
  | { kind: "form"; existing?: Transaction; preset?: FormPreset; back: PanelView };

interface PanelProps {
  budget: Budget;
  transactions: Transaction[];
  unassignedCount: number; // in every month
  view: PanelView;
  onView: (v: PanelView) => void;
  onChanged: () => Promise<void>;
}

export default function SidePanel({ budget, transactions, unassignedCount, view, onView, onChanged }: PanelProps) {
  const tabClass = (on: boolean) => `relative flex flex-1 justify-center rounded-md py-2 ${on ? "bg-white text-ink shadow-sm" : "text-action"}`;
  const openForm = (back: PanelView, existing?: Transaction, preset?: FormPreset) => onView({ kind: "form", existing, preset, back });

  // The panel shows `shown`; the transaction editor is a popup on top of whatever was showing
  const form = view.kind === "form" ? view : null;
  const shown: Exclude<PanelView, { kind: "form" }> = form ? (form.back.kind === "form" ? { kind: "transactions" } : form.back) : (view as Exclude<PanelView, { kind: "form" }>);

  let content;
  if (shown.kind === "summary") {
    content = <SummaryChart budget={budget} />;
  } else if (shown.kind === "transactions") {
    content = (
      <TransactionList
        budget={budget}
        transactions={transactions}
        onAdd={() => openForm(shown)}
        onOpen={(t) => openForm(shown, t)}
        onChanged={onChanged}
      />
    );
  } else {
    const target = `${shown.item.type === "line" ? "l" : "i"}:${shown.item.id}`;
    content = (
      <ItemDetail
        budget={budget}
        item={shown.item}
        transactions={transactions}
        onAdd={() => openForm(shown, undefined, { type: shown.item.type === "income" ? "income" : "expense", target })}
        onOpen={(t) => openForm(shown, t)}
        onClose={() => onView({ kind: "summary" })}
        onChanged={onChanged}
      />
    );
  }

  const popup = form && (
    <FormForMonth
      key={form.existing?.id ?? `new-${form.preset?.target ?? ""}`}
      budget={budget}
      existing={form.existing}
      preset={form.preset}
      onCancel={() => onView(form.back)}
      onSaved={async () => {
        await onChanged();
        onView(form.back);
      }}
    />
  );

  return (
    <aside aria-label="Budget side panel" className="rounded-2xl bg-white p-4">
      <div className="flex rounded-lg bg-page p-1">
        <button onClick={() => onView({ kind: "summary" })} aria-label="Summary chart" className={tabClass(shown.kind === "summary")}>
          <PieIcon className="size-6" />
        </button>
        {/* The count of new transactions takes the place of the $ */}
        <button
          onClick={() => onView({ kind: "transactions" })}
          aria-label={unassignedCount > 0 ? `Transactions, ${unassignedCount} new` : "Transactions"}
          className={`${tabClass(shown.kind === "transactions")} items-center text-lg font-semibold`}
        >
          {unassignedCount > 0 ? (
            <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-sm font-bold tabular-nums text-white">
              {unassignedCount > 99 ? "99+" : unassignedCount}
            </span>
          ) : (
            "$"
          )}
        </button>
      </div>
      <div className="mt-2">{content}</div>
      {popup}
    </aside>
  );
}
