import { useCallback, useEffect, useState } from "react";
import { api, type Budget, type MonthResponse } from "../api";
import { currentYearMonth, type YearMonth } from "../dates";
import AddGroup from "./AddGroup";
import CreateMonth from "./CreateMonth";
import GroupCard from "./GroupCard";
import type { SecondColumn } from "./ItemRow";
import MonthHeader from "./MonthHeader";
import SummaryBanner from "./SummaryBanner";
import SummaryRail from "./SummaryRail";

export default function BudgetPage() {
  const [ym, setYm] = useState<YearMonth>(currentYearMonth);
  const [data, setData] = useState<MonthResponse | null>(null);
  const [months, setMonths] = useState<YearMonth[]>([]);
  const [column, setColumn] = useState<SecondColumn>("actual");
  const [error, setError] = useState("");
  const [newGroupId, setNewGroupId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [month, list] = await Promise.all([
      api<MonthResponse>("GET", `/api/months/${ym.year}/${ym.month}`),
      api<YearMonth[]>("GET", "/api/months"),
    ]);
    setData(month);
    setMonths(list);
  }, [ym]);

  useEffect(() => {
    setData(null);
    load().catch((e) => setError(e.message));
  }, [load]);

  // Run a change, show any error, then refresh the budget
  const change = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        setError("");
        await fn();
      } catch (e) {
        setError((e as Error).message);
      }
      await load().catch((e) => setError(e.message));
    },
    [load]
  );

  const budget = data?.exists ? (data as Budget) : null;

  return (
    <div className="mx-auto flex max-w-[1140px] flex-col gap-6 px-3 pb-16 sm:px-6 min-[1100px]:flex-row">
      {/* Budget column */}
      <div className="w-full min-w-0 min-[1100px]:max-w-[620px] min-[1100px]:flex-1">
        <div className="sticky top-0 z-20 bg-page pb-4 pt-4">
          <MonthHeader value={ym} onChange={setYm} existing={months} />
          {budget && (
            <div className="mt-4">
              <SummaryBanner totals={budget.totals} />
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-error-subtle px-4 py-3 text-error">
            <span>{error}</span>
            <button onClick={() => setError("")} className="font-semibold">Dismiss</button>
          </div>
        )}

        {!data && <div className="py-16 text-center text-subtle">Loading…</div>}

        {data && !data.exists && (
          <CreateMonth
            missing={data}
            onCreate={(mode) => change(() => api("POST", `/api/months/${ym.year}/${ym.month}`, { mode }))}
          />
        )}

        {budget && (
          <>
            <GroupCard
              kind="income"
              title="Income"
              rows={budget.income.map((i) => ({ id: i.id, name: i.name, plannedCents: i.plannedCents, actualCents: i.receivedCents }))}
              column={column}
              onColumnChange={setColumn}
              onAddItem={(name, plannedCents) => change(() => api("POST", `/api/months/${budget.id}/income`, { name, plannedCents }))}
              onUpdateItem={(id, changes) => change(() => api("PATCH", `/api/income/${id}`, changes))}
              onDeleteItem={(id) => change(() => api("DELETE", `/api/income/${id}`))}
            />

            {budget.groups.map((g) => (
              <GroupCard
                key={g.id}
                kind="expense"
                title={g.name}
                startWithDraft={g.id === newGroupId}
                rows={g.items.map((i) => ({ id: i.id, name: i.name, plannedCents: i.plannedCents, actualCents: i.spentCents }))}
                column={column}
                onColumnChange={setColumn}
                onRename={(name) => change(() => api("PATCH", `/api/groups/${g.id}`, { name }))}
                onDelete={() => change(() => api("DELETE", `/api/groups/${g.id}`))}
                onAddItem={(name, plannedCents) => change(() => api("POST", `/api/groups/${g.id}/items`, { name, plannedCents }))}
                onUpdateItem={(id, changes) => change(() => api("PATCH", `/api/items/${id}`, changes))}
                onDeleteItem={(id) => change(() => api("DELETE", `/api/items/${id}`))}
              />
            ))}

            <AddGroup
              onAdd={(name) =>
                change(async () => {
                  const g = await api<{ id: number }>("POST", `/api/months/${budget.id}/groups`, { name });
                  setNewGroupId(g.id);
                })
              }
            />
          </>
        )}
      </div>

      {/* Summary rail */}
      {budget && (
        <div className="w-full min-[1100px]:sticky min-[1100px]:top-4 min-[1100px]:mt-4 min-[1100px]:w-[400px] min-[1100px]:self-start">
          <SummaryRail budget={budget} />
        </div>
      )}
    </div>
  );
}
