import { useState } from "react";
import { formatCents } from "../money";
import ItemRow, { DraftRow, secondValue, type RowData, type SecondColumn } from "./ItemRow";
import { InlineText } from "./inputs";
import { ChevronDown, ChevronUp, Trash } from "./Icons";

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
}

export default function GroupCard(props: Props) {
  const { kind, title, rows, column, onColumnChange } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [drafting, setDrafting] = useState(!!props.startWithDraft);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const actualLabel = kind === "income" ? "Received" : "Spent";
  const plannedTotal = rows.reduce((t, r) => t + r.plannedCents, 0);
  const secondTotal = rows.reduce((t, r) => t + secondValue(r, column), 0);

  return (
    <section
      aria-label={title}
      className="group/card mb-6 overflow-hidden rounded-2xl bg-white"
    >
      {/* Header */}
      <header className="flex items-center gap-2 px-4 pb-2 pt-6 sm:px-6">
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

      {!collapsed && (
        <>
          {rows.map((row) => (
            <ItemRow
              key={row.id}
              row={row}
              column={column}
              onSave={(changes) => props.onUpdateItem(row.id, changes)}
              onDelete={() => props.onDeleteItem(row.id)}
              onAmountEnter={() => setDrafting(true)}
            />
          ))}
          {drafting && <DraftRow onCreate={props.onAddItem} onClose={() => setDrafting(false)} />}

          {/* Footer */}
          <footer className="flex items-center gap-2 px-4 pb-6 pt-4 sm:px-6">
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
          </footer>
        </>
      )}
    </section>
  );
}
