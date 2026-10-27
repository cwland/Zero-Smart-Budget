import { arrayMove } from "@dnd-kit/sortable";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { Budget } from "../api";

// Drag ids look like "group-3", "item-12", "income-5"
export type DragKind = "group" | "item" | "income";

export function parseDragId(id: UniqueIdentifier | null | undefined): { kind: DragKind; id: number } | null {
  const m = /^(group|item|income)-(\d+)$/.exec(String(id ?? ""));
  return m ? { kind: m[1] as DragKind, id: Number(m[2]) } : null;
}

export const groupOfItem = (b: Budget, itemId: number) => b.groups.find((g) => g.items.some((i) => i.id === itemId));

// While dragging an item over another group, move it there (so that group opens a gap for it)
export function moveItemAcrossGroups(b: Budget, itemId: number, overId: UniqueIdentifier): Budget | null {
  const over = parseDragId(overId);
  const from = groupOfItem(b, itemId);
  if (!over || !from) return null;
  const to = over.kind === "group" ? b.groups.find((g) => g.id === over.id) : over.kind === "item" ? groupOfItem(b, over.id) : undefined;
  if (!to || to.id === from.id) return null;

  const item = from.items.find((i) => i.id === itemId)!;
  const overIndex = over.kind === "item" ? to.items.findIndex((i) => i.id === over.id) : -1;
  const insertAt = overIndex >= 0 ? overIndex : to.items.length;

  return {
    ...b,
    groups: b.groups.map((g) => {
      if (g.id === from.id) return { ...g, items: g.items.filter((i) => i.id !== itemId) };
      if (g.id === to.id) return { ...g, items: [...g.items.slice(0, insertAt), item, ...g.items.slice(insertAt)] };
      return g;
    }),
  };
}

// Final reorder when the drag ends. Returns the new budget, or null if nothing changed.
export function applyDrop(b: Budget, activeId: UniqueIdentifier, overId: UniqueIdentifier): Budget | null {
  const active = parseDragId(activeId);
  const over = parseDragId(overId);
  if (!active || !over || activeId === overId) return null;

  if (active.kind === "group" && over.kind === "group") {
    const from = b.groups.findIndex((g) => g.id === active.id);
    const to = b.groups.findIndex((g) => g.id === over.id);
    return from < 0 || to < 0 ? null : { ...b, groups: arrayMove(b.groups, from, to) };
  }

  if (active.kind === "income" && over.kind === "income") {
    const from = b.income.findIndex((i) => i.id === active.id);
    const to = b.income.findIndex((i) => i.id === over.id);
    return from < 0 || to < 0 ? null : { ...b, income: arrayMove(b.income, from, to) };
  }

  if (active.kind === "item" && over.kind === "item") {
    const g = groupOfItem(b, active.id);
    if (!g || groupOfItem(b, over.id)?.id !== g.id) return null;
    const from = g.items.findIndex((i) => i.id === active.id);
    const to = g.items.findIndex((i) => i.id === over.id);
    return { ...b, groups: b.groups.map((x) => (x.id === g.id ? { ...x, items: arrayMove(x.items, from, to) } : x)) };
  }
  return null;
}
