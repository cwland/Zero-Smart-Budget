import { useEffect, useState } from "react";
import { api, type Budget, type MonthResponse, type Transaction } from "../api";
import { monthLabel } from "../dates";
import ItemDetail, { type ItemRef } from "./ItemDetail";
import TransactionForm, { type FormPreset } from "./TransactionForm";
import TransactionList from "./TransactionList";
import { formatCents, formatWholeDollars } from "../money";
import { PieIcon } from "./Icons";

// One color per group, in order
export const GROUP_COLORS = [
  "#00b2f6", "#e64b40", "#faab19", "#35bd59", "#634fb3", "#e66f20",
  "#0073b9", "#24a344", "#f26552", "#b88907", "#003561", "#8e999e",
];

type Metric = "planned" | "spent" | "remaining";

function Donut({ values, colors, centerLabel, centerValue }: { values: number[]; colors: string[]; centerLabel: string; centerValue: string }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const total = values.reduce((t, v) => t + Math.max(0, v), 0);
  let offset = 0;

  return (
    <div className="relative mx-auto size-48">
      <svg viewBox="0 0 180 180" className="size-full -rotate-90">
        <circle cx="90" cy="90" r={r} fill="none" stroke="#e8eced" strokeWidth="18" />
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

  const income = budget.totals.incomePlannedCents;
  const colors = budget.groups.map((_, i) => GROUP_COLORS[i % GROUP_COLORS.length]);
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
  const [error, setError] = useState("");

  useEffect(() => {
    if (sameMonth) return;
    api<MonthResponse>("GET", `/api/months/${ym.year}/${ym.month}`)
      .then(setOther)
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sameMonth, ym.year, ym.month]);

  if (sameMonth) return <TransactionForm {...props} />;
  if (error) return <p role="alert" className="p-4 text-error">{error}</p>;
  if (!other) return <p className="p-6 text-center text-subtle">Loading {monthLabel(ym)}…</p>;
  if (!other.exists) {
    return (
      <div className="p-4">
        <button onClick={props.onCancel} className="text-sm font-semibold text-action hover:underline">
          ‹ Back
        </button>
        <p className="mt-4 font-semibold">{existing?.merchant}</p>
        <p className="mt-2 text-subtle">
          This transaction is in {monthLabel(ym)}, which has no budget yet. Create the {monthLabel(ym)} budget (use the arrows at the top) to assign it.
        </p>
      </div>
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

  let content;
  if (view.kind === "summary") {
    content = <SummaryChart budget={budget} />;
  } else if (view.kind === "transactions") {
    content = (
      <TransactionList
        budget={budget}
        transactions={transactions}
        onAdd={() => openForm(view)}
        onOpen={(t) => openForm(view, t)}
        onChanged={onChanged}
      />
    );
  } else if (view.kind === "item") {
    const target = `${view.item.type === "line" ? "l" : "i"}:${view.item.id}`;
    content = (
      <ItemDetail
        budget={budget}
        item={view.item}
        transactions={transactions}
        onAdd={() => openForm(view, undefined, { type: view.item.type === "income" ? "income" : "expense", target })}
        onOpen={(t) => openForm(view, t)}
        onClose={() => onView({ kind: "summary" })}
        onChanged={onChanged}
      />
    );
  } else {
    content = (
      <FormForMonth
        key={view.existing?.id ?? "new"}
        budget={budget}
        existing={view.existing}
        preset={view.preset}
        onCancel={() => onView(view.back)}
        onSaved={async () => {
          await onChanged();
          onView(view.back);
        }}
      />
    );
  }

  return (
    <aside aria-label="Budget side panel" className="rounded-2xl bg-white p-4">
      <div className="flex rounded-lg bg-page p-1">
        <button onClick={() => onView({ kind: "summary" })} aria-label="Summary chart" className={tabClass(view.kind === "summary")}>
          <PieIcon className="size-5" />
        </button>
        <button onClick={() => onView({ kind: "transactions" })} aria-label="Transactions" className={`${tabClass(view.kind === "transactions")} text-lg font-semibold`}>
          $
          {unassignedCount > 0 && (
            <span aria-label={`${unassignedCount} unassigned`} className="absolute right-3 top-1.5 rounded-full bg-warning px-1.5 text-xs font-semibold leading-5 text-white">
              {unassignedCount}
            </span>
          )}
        </button>
      </div>
      <div className="mt-2">{content}</div>
    </aside>
  );
}
