import { useState } from "react";
import type { Budget } from "../api";
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

export default function SummaryRail({ budget }: { budget: Budget }) {
  const [tab, setTab] = useState<"chart" | "transactions">("chart");
  const [metric, setMetric] = useState<Metric>("planned");

  const income = budget.totals.incomePlannedCents;
  const colors = budget.groups.map((_, i) => GROUP_COLORS[i % GROUP_COLORS.length]);
  const valueOf = (g: Budget["groups"][number]) =>
    metric === "planned" ? g.plannedCents : metric === "spent" ? g.spentCents : g.remainingCents;
  const values = budget.groups.map(valueOf);
  const centerValue =
    metric === "planned" ? income : metric === "spent" ? budget.totals.spentCents : budget.totals.remainingCents;

  return (
    <aside aria-label="Budget summary" className="rounded-2xl bg-white p-4">
      {/* Tabs: chart / transactions */}
      <div className="flex rounded-lg bg-page p-1">
        <button
          onClick={() => setTab("chart")}
          aria-label="Summary chart"
          className={`flex flex-1 justify-center rounded-md py-2 ${tab === "chart" ? "bg-white text-ink shadow-sm" : "text-action"}`}
        >
          <PieIcon className="size-5" />
        </button>
        <button
          onClick={() => setTab("transactions")}
          aria-label="Transactions"
          className={`flex flex-1 justify-center rounded-md py-2 text-lg font-semibold ${tab === "transactions" ? "bg-white text-ink shadow-sm" : "text-action"}`}
        >
          $
        </button>
      </div>

      {tab === "transactions" ? (
        <p className="px-2 py-10 text-center text-subtle">Transactions arrive in the next step.</p>
      ) : (
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
      )}
    </aside>
  );
}
