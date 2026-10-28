import { useSyncExternalStore } from "react";
import type { Transaction } from "./api";

// Dragging a transaction from the side panel onto a budget item (like EveryDollar).
// Uses the browser's own drag-and-drop, separate from dnd-kit (which reorders groups and items),
// so the two never get in each other's way. This tiny store says what's being dragged.

let dragging: Transaction | null = null;
const listeners = new Set<() => void>();

export function setDraggedTransaction(t: Transaction | null) {
  dragging = t;
  listeners.forEach((l) => l());
}

export function useDraggedTransaction() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dragging
  );
}

// Can this transaction go on an item of this kind in this month?
// Expenses go on budget items; income goes on income items or on budget items (as money back).
export function canDropOn(t: Transaction | null, target: { kind: "income" | "expense"; year: number; month: number }) {
  if (!t) return false;
  if (Number(t.date.slice(0, 4)) !== target.year || Number(t.date.slice(5, 7)) !== target.month) return false;
  if (target.kind === "income" && t.type !== "income") return false;
  return true;
}
