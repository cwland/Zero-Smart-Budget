import { useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatCents } from "../money";
import ItemRow, { DraftRow, secondValue, type RowData, type SecondColumn } from "./ItemRow";
import { InlineText } from "./inputs";
import { ChevronDown, ChevronUp, GripIcon, Trash } from "./Icons";

interface Props {
  kind: "income" | "expense";
  title: string;
  rows: RowData[];
  column: SecondColumn;
  onColumnChange: (c: SecondColumn) => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  onAddItem: (name: string, plannedCents: number) => Promise<void>;
  onUpdateItem: (id: number, changes: { name?: string; plannedCents?: number }) => void;
  onDeleteItem: (id: number) => void;
  startWithDraft?: boolean;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  // Drag ids: the card itself (expense groups only) and the prefix for its rows ("item" / "income")
  sortableId?: string;
  rowPrefix: string;
  compact?: boolean; // header only (while a group is being dragged)
  favorites?: boolean; // the Favorites card: no Add Item / totals, rows reorder in their own group
  canDropTx?: boolean; // a dragged transaction can land on this card's items
  onDropTx?: (rowId: number) => void;
}

export default function GroupCard(props: Props) {
  const { kind, title, rows, column, onColumnChange } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [drafting, setDrafting] = useState(!!props.startWithDraft);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const actualLabel = kind === "income" ? "Received" : "Spent";
  const plannedTotal = rows.reduce((t, r) => t + r.plannedCents, 0);
  const secondTotal = rows.reduce((t, r) => t + secondValue(r, column), 0);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: props.sortableId ?? "income-card",
    disabled: !props.sortableId,
  });

  return (
    <section
      ref={setNodeRef}
      data-drag-id={props.sortableId}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={title}
      className={`group/card relative mb-6 overflow-hidden rounded-2xl bg-white ${isDragging ? "z-30 shadow-[0_12px_32px_rgba(31,36,38,0.18)]" : ""}`}
    >
      {/* Header */}
      <header className={`relative flex items-center gap-2 px-4 pt-6 sm:px-6 ${props.compact ? "pb-6" : "pb-2"}`}>
        {props.sortableId && (
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder group ${title}`}
            className="absolute left-0 top-6 flex h-8 w-4 cursor-grab touch-none items-center justify-center text-muted opacity-40 hover:text-ink focus:opacity-100 active:cursor-grabbing sm:left-1 sm:w-5 sm:opacity-0 sm:group-hover/card:opacity-100"
          >
            <GripIcon />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {props.onRename ? (
            <InlineText
              value={title}
              ariaLabel="Group name"
              onSave={props.onRename}
              size={Math.max(title.length, 6)}
              className="-ml-1 max-w-full font-semibold text-subtle"
            />
          ) : (
            <span className="font-semibold text-subtle">{title}</span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="rounded p-1 text-subtle hover:bg-page"
          >
            {collapsed ? <ChevronDown /> : <ChevronUp />}
          </button>
          {props.onDelete && (
            <button
              onClick={() => (confirmDelete ? props.onDelete!() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              aria-label={confirmDelete ? `Confirm delete group ${title}` : `Delete group ${title}`}
              className={`rounded p-1 transition ${
                confirmDelete
                  ? "bg-error px-2 text-xs font-semibold text-white"
                  : "text-muted opacity-0 hover:bg-error-subtle hover:text-error focus:opacity-100 group-hover/card:opacity-100"
              }`}
            >
              {confirmDelete ? "Delete group" : <Trash />}
            </button>
          )}
        </div>
        <div className="w-24 shrink-0 sm:w-[7.5rem] text-right text-sm text-subtle">Planned</div>
        <label className="relative flex w-[5.5rem] shrink-0 sm:w-[6.5rem] items-center justify-end text-sm text-subtle">
          <select
            aria-label="Second column"
            value={column}
            onChange={(e) => onColumnChange(e.target.value as SecondColumn)}
            className="cursor-pointer appearance-none bg-transparent pr-5 text-right outline-none hover:text-ink"
          >
            <option value="actual">{actualLabel}</option>
            <option value="remaining">Remaining</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-0 size-3.5" />
        </label>
      </header>

      {!collapsed && !props.compact && (
        <>
          <SortableContext items={rows.map((r) => `${props.rowPrefix}-${r.id}`)} strategy={verticalListSortingStrategy}>
          {rows.map((row) => (
            <ItemRow
              key={row.id}
              sortableId={`${props.rowPrefix}-${row.id}`}
              sortable={!props.favorites}
              row={row}
              column={column}
              onSave={(changes) => props.onUpdateItem(row.id, changes)}
              onDelete={() => props.onDeleteItem(row.id)}
              onAmountEnter={() => setDrafting(true)}
              selected={props.selectedId === row.id}
              onSelect={() => props.onSelect?.(row.id)}
              canDropTx={props.canDropTx}
              onDropTx={() => props.onDropTx?.(row.id)}
            />
          ))}
          </SortableContext>
          {drafting && <DraftRow onCreate={props.onAddItem} onClose={() => setDrafting(false)} />}

          {/* Footer (the Favorites card has none, like EveryDollar) */}
          {props.favorites ? <div className="pb-4" /> : <footer className="flex items-center gap-2 px-4 pb-6 pt-4 sm:px-6">
            <button
              onClick={() => setDrafting(true)}
              className="flex-1 whitespace-nowrap text-left text-link hover:underline"
            >
              {kind === "income" ? "Add Income" : "Add Item"}
            </button>
            <div className="tabular w-24 shrink-0 sm:w-[7.5rem] pr-1 text-right text-subtle">{formatCents(plannedTotal)}</div>
            <div className={`tabular w-[5.5rem] shrink-0 sm:w-[6.5rem] text-right ${secondTotal < 0 ? "text-error" : "text-subtle"}`}>
              {formatCents(secondTotal)}
            </div>
          </footer>}
        </>
      )}
    </section>
  );
}
