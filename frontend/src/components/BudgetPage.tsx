import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { api, type Budget, type MonthResponse, type Transaction } from "../api";
import { currentYearMonth, type YearMonth } from "../dates";
import { formatCents } from "../money";
import { applyDrop, groupOfItem, moveItemAcrossGroups, parseDragId } from "./dragLogic";
import AddGroup from "./AddGroup";
import CreateMonth from "./CreateMonth";
import GroupCard from "./GroupCard";
import type { SecondColumn } from "./ItemRow";
import MonthHeader from "./MonthHeader";
import SummaryBanner from "./SummaryBanner";
import SidePanel, { type PanelView } from "./SidePanel";

export default function BudgetPage() {
  const [ym, setYm] = useState<YearMonth>(currentYearMonth);
  const [data, setData] = useState<MonthResponse | null>(null);
  const [months, setMonths] = useState<YearMonth[]>([]);
  const [column, setColumn] = useState<SecondColumn>("actual");
  const [error, setError] = useState("");
  const [newGroupId, setNewGroupId] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [view, setView] = useState<PanelView>({ kind: "summary" });
  const panelRef = useRef<HTMLDivElement>(null);

  // Every load gets a number; only the newest one may update the screen. Without this, a slow
  // answer for the month you just left can arrive last and show the wrong month's budget.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [month, list, txs] = await Promise.all([
      api<MonthResponse>("GET", `/api/months/${ym.year}/${ym.month}`),
      api<YearMonth[]>("GET", "/api/months"),
      api<Transaction[]>("GET", `/api/transactions?year=${ym.year}&month=${ym.month}`),
    ]);
    if (seq !== loadSeq.current) return;
    setData(month);
    setMonths(list);
    setTransactions(txs);
  }, [ym]);

  useEffect(() => {
    setData(null);
    setView({ kind: "summary" });
    load().catch((e) => setError(e.message));
  }, [load]);

  // On narrow screens the panel sits below the budget, so bring it into view when it changes
  const showView = (v: PanelView) => {
    setView(v);
    if (v.kind !== "summary" && window.innerWidth < 1100) {
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };
  const selectedLine = view.kind === "item" && view.item.type === "line" ? view.item.id : null;
  const selectedIncome = view.kind === "item" && view.item.type === "income" ? view.item.id : null;

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
  const favoriteItems = budget ? budget.groups.flatMap((g) => g.items.filter((i) => i.favorite)) : [];

  // ---------- drag to reorder ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [dragStart, setDragStart] = useState<{ snapshot: Budget; activeId: string } | null>(null);

  // Only let groups land on groups, income on income, and items on items (or a group, to drop at its end)
  const collision: CollisionDetection = (args) => {
    const kind = parseDragId(args.active.id)?.kind;
    const allowed = args.droppableContainers.filter((c) => {
      const k = parseDragId(c.id)?.kind;
      return kind === "item" ? k === "item" || k === "group" : k === kind;
    });
    if (kind === "item") {
      const hits = pointerWithin({ ...args, droppableContainers: allowed });
      const itemHit = hits.find((h) => parseDragId(h.id)?.kind === "item");
      if (itemHit) return [itemHit];
      if (hits.length) return [hits[0]];
      return closestCenter({ ...args, droppableContainers: allowed.filter((c) => parseDragId(c.id)?.kind === "item") });
    }
    // Group cards have very different heights, so compare corners rather than centers
    return kind === "group" ? closestCorners({ ...args, droppableContainers: allowed }) : closestCenter({ ...args, droppableContainers: allowed });
  };

  const draggingGroup = parseDragId(dragStart?.activeId)?.kind === "group";

  const onDragStart = ({ active }: DragStartEvent) => {
    if (!budget) return;
    setDragStart({ snapshot: budget, activeId: String(active.id) });
    // Groups collapse to their headers while one is dragged; keep the dragged one in view
    if (parseDragId(active.id)?.kind === "group") {
      requestAnimationFrame(() =>
        document.querySelector(`[data-drag-id="${String(active.id)}"]`)?.scrollIntoView({ block: "center" })
      );
    }
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const a = parseDragId(active.id);
    if (!budget || !over || a?.kind !== "item") return;
    const moved = moveItemAcrossGroups(budget, a.id, over.id);
    if (moved) setData({ ...moved, exists: true });
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    const start = dragStart;
    setDragStart(null);
    if (!budget || !start) return;
    const a = parseDragId(active.id)!;
    const next = (over && applyDrop(budget, active.id, over.id)) || budget;
    if (next !== budget) setData({ ...next, exists: true });

    await change(async () => {
      if (a.kind === "group") {
        if (next === budget) return;
        await api("PUT", `/api/months/${next.id}/groups/order`, { ids: next.groups.map((g) => g.id) });
      } else if (a.kind === "income") {
        if (next === budget) return;
        await api("PUT", `/api/months/${next.id}/income/order`, { ids: next.income.map((i) => i.id) });
      } else {
        const fromGroup = groupOfItem(start.snapshot, a.id)!;
        const toGroup = groupOfItem(next, a.id)!;
        const before = fromGroup.items.map((i) => i.id).join();
        const after = toGroup.items.map((i) => i.id).join();
        if (fromGroup.id === toGroup.id && before === after) return;
        if (fromGroup.id !== toGroup.id) await api("PATCH", `/api/items/${a.id}`, { groupId: toGroup.id });
        await api("PUT", `/api/groups/${toGroup.id}/items/order`, { ids: toGroup.items.map((i) => i.id) });
      }
    });
  };

  const onDragCancel = () => {
    if (dragStart) setData({ ...dragStart.snapshot, exists: true });
    setDragStart(null);
  };

  // A floating copy of the row being dragged (it can move between group cards)
  const activeItem = (() => {
    const a = parseDragId(dragStart?.activeId);
    if (!budget || !a || a.kind === "group") return null;
    if (a.kind === "income") return budget.income.find((i) => i.id === a.id) ?? null;
    return groupOfItem(budget, a.id)?.items.find((i) => i.id === a.id) ?? null;
  })();

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
          <DndContext
            sensors={sensors}
            collisionDetection={collision}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            accessibility={{ screenReaderInstructions: { draggable: "Press space to pick up, arrow keys to move, space to drop, escape to cancel." } }}
          >
            <GroupCard
              kind="income"
              rowPrefix="income"
              title="Income"
              rows={budget.income.map((i) => ({ id: i.id, name: i.name, plannedCents: i.plannedCents, actualCents: i.receivedCents }))}
              column={column}
              onColumnChange={setColumn}
              onAddItem={(name, plannedCents) => change(() => api("POST", `/api/months/${budget.id}/income`, { name, plannedCents }))}
              onUpdateItem={(id, changes) => change(() => api("PATCH", `/api/income/${id}`, changes))}
              onDeleteItem={(id) => change(() => api("DELETE", `/api/income/${id}`))}
              selectedId={selectedIncome}
              onSelect={(id) => showView({ kind: "item", item: { type: "income", id } })}
            />

            {/* Favorites: starred items from any group (they stay in their own groups too) */}
            {favoriteItems.length > 0 && !draggingGroup && (
              <GroupCard
                kind="expense"
                favorites
                title="Favorites"
                rowPrefix="fav"
                rows={favoriteItems.map((i) => ({ id: i.id, name: i.name, plannedCents: i.plannedCents, actualCents: i.spentCents, fund: i.sinkingFund }))}
                column={column}
                onColumnChange={setColumn}
                onAddItem={async () => {}}
                onUpdateItem={(id, changes) => change(() => api("PATCH", `/api/items/${id}`, changes))}
                onDeleteItem={(id) => change(() => api("DELETE", `/api/items/${id}`))}
                selectedId={selectedLine}
                onSelect={(id) => showView({ kind: "item", item: { type: "line", id } })}
              />
            )}

            <SortableContext items={budget.groups.map((g) => `group-${g.id}`)} strategy={verticalListSortingStrategy}>
            {budget.groups.map((g) => (
              <GroupCard
                key={g.id}
                kind="expense"
                sortableId={`group-${g.id}`}
                compact={draggingGroup}
                rowPrefix="item"
                title={g.name}
                startWithDraft={g.id === newGroupId}
                rows={g.items.map((i) => ({ id: i.id, name: i.name, plannedCents: i.plannedCents, actualCents: i.spentCents, fund: i.sinkingFund }))}
                column={column}
                onColumnChange={setColumn}
                onRename={(name) => change(() => api("PATCH", `/api/groups/${g.id}`, { name }))}
                onDelete={() => change(() => api("DELETE", `/api/groups/${g.id}`))}
                onAddItem={(name, plannedCents) => change(() => api("POST", `/api/groups/${g.id}/items`, { name, plannedCents }))}
                onUpdateItem={(id, changes) => change(() => api("PATCH", `/api/items/${id}`, changes))}
                onDeleteItem={(id) => change(() => api("DELETE", `/api/items/${id}`))}
                selectedId={selectedLine}
                onSelect={(id) => showView({ kind: "item", item: { type: "line", id } })}
              />
            ))}
            </SortableContext>

            <DragOverlay>
              {activeItem && (
                <div className="flex items-center gap-2 rounded-lg bg-white px-6 py-4 text-lg shadow-[0_12px_32px_rgba(31,36,38,0.2)]">
                  <span className="flex-1 truncate">{activeItem.name}</span>
                  <span className="tabular text-action">{formatCents(activeItem.plannedCents)}</span>
                </div>
              )}
            </DragOverlay>

            <AddGroup
              onAdd={(name) =>
                change(async () => {
                  const g = await api<{ id: number }>("POST", `/api/months/${budget.id}/groups`, { name });
                  setNewGroupId(g.id);
                })
              }
            />
          </DndContext>
        )}
      </div>

      {/* Summary rail */}
      {budget && (
        <div
          ref={panelRef}
          className="w-full scroll-mt-4 min-[1100px]:sticky min-[1100px]:top-4 min-[1100px]:mt-4 min-[1100px]:max-h-[calc(100vh-2rem)] min-[1100px]:w-[400px] min-[1100px]:self-start min-[1100px]:overflow-y-auto min-[1100px]:rounded-2xl"
        >
          <SidePanel budget={budget} transactions={transactions} view={view} onView={showView} onChanged={load} />
        </div>
      )}
    </div>
  );
}
