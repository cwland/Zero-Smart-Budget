import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatCents } from "../money";
import { InlineText, MoneyInput } from "./inputs";
import { GoalIcon, GripIcon, PiggyIcon, Trash } from "./Icons";

export interface RowData {
  id: number;
  name: string;
  plannedCents: number;
  actualCents: number; // spent (expenses) or received (income)
  fund?: { name: string; kind?: "sinking" | "goal"; balanceCents: number; targetCents: number | null; goalReached?: boolean } | null;
  lockedNote?: string; // planned amount can't be changed here (e.g. a rollover); why
}

export type SecondColumn = "actual" | "remaining";

interface Props {
  row: RowData;
  column: SecondColumn;
  onSave: (changes: { name?: string; plannedCents?: number }) => void;
  onDelete: () => void;
  onAmountEnter: () => void;
  selected?: boolean;
  onSelect?: () => void;
  sortableId: string;
  sortable?: boolean; // false for the Favorites card (reorder items in their own group)
  canDropTx?: boolean; // a transaction being dragged could be dropped here
  onDropTx?: () => void;
  onAddTx?: () => void; // "+": add a transaction already set to this item
  itemKey?: string; // "l:12" / "i:3": where accepted transactions are tossed
  readOnly?: boolean; // closed month: the plan can't be changed
}

export function ProgressBar({ actual, planned }: { actual: number; planned: number }) {
  const over = actual > planned;
  const pct = planned > 0 ? Math.min(100, (actual / planned) * 100) : actual > 0 ? 100 : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-strong" aria-hidden>
      <div className={`h-full rounded ${over ? "bg-error" : "bg-success"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function secondValue(row: { plannedCents: number; actualCents: number }, column: SecondColumn) {
  return column === "actual" ? row.actualCents : row.plannedCents - row.actualCents;
}

export default function ItemRow({ row, column, onSave, onDelete, onAmountEnter, selected, onSelect, sortableId, sortable = true, canDropTx, onDropTx, onAddTx, itemKey, readOnly }: Props) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [dropOver, setDropOver] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const second = secondValue(row, column);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId, disabled: !sortable || readOnly });
  const plannedLocked = readOnly || !!row.lockedNote;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group/row relative cursor-pointer px-4 sm:px-6 ${dropOver ? "bg-active ring-2 ring-inset ring-action" : selected ? "bg-active" : "bg-white hover:bg-page"} ${isDragging ? "z-10 opacity-40" : ""}`}
      data-drop-target={canDropTx ? "yes" : undefined}
      data-item-row={itemKey}
      onDragOver={(e) => {
        if (!canDropTx) return;
        e.preventDefault(); // allows the drop
        e.dataTransfer.dropEffect = "move";
        if (!dropOver) setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        if (canDropTx) onDropTx?.();
      }}
      onClick={(e) => {
        // Clicks on the name/amount boxes edit; clicks anywhere else on the row open its details
        if (!(e.target as HTMLElement).closest("input,button,select")) onSelect?.();
      }}
    >
      {sortable && !readOnly && <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${row.name}`}
        className="absolute left-0 top-1/2 flex h-10 w-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-muted opacity-40 hover:text-ink focus:opacity-100 active:cursor-grabbing sm:left-1 sm:w-5 sm:opacity-0 sm:group-hover/row:opacity-100"
      >
        <GripIcon />
      </button>}
      <div className="flex items-center gap-2 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1">
            {readOnly ? (
              <span className="min-w-0 flex-1 truncate px-1 py-1 text-base sm:text-lg">{row.name}</span>
            ) : (
              <InlineText
                value={row.name}
                ariaLabel="Item name"
                onSave={(name) => onSave({ name })}
                onEnter={() => amountRef.current?.focus()}
                className="min-w-0 flex-1 text-base sm:text-lg"
              />
            )}
            {onAddTx && (
              <button
                onClick={onAddTx}
                aria-label={`Add transaction to ${row.name}`}
                title={`Add a transaction to ${row.name}`}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-action opacity-60 hover:bg-pressed hover:opacity-100 focus:opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100"
              >
                <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            )}
          </span>
          {row.fund && (
            <span title={`${row.fund.kind === "goal" ? "Goal" : "Sinking fund"}: ${row.fund.name}`} className="tabular flex items-center gap-1 px-1 text-sm text-success">
              {row.fund.kind === "goal" ? <GoalIcon className="size-4 shrink-0" /> : <PiggyIcon className="size-4 shrink-0" />}
              <span className="truncate">
                {formatCents(row.fund.balanceCents)}
                {row.fund.targetCents ? ` of ${formatCents(row.fund.targetCents)}` : " saved"}
                {row.fund.goalReached ? " · Goal reached 🎉" : ""}
              </span>
            </span>
          )}
        </div>
        <div className="w-24 shrink-0 sm:w-[7.5rem]">
          {plannedLocked ? (
            <span title={row.lockedNote} aria-label={`Planned for ${row.name}`} className="tabular block px-1 py-1 text-right text-base text-subtle sm:text-lg">
              {formatCents(row.plannedCents)}
            </span>
          ) : (
            <MoneyInput
              ref={amountRef}
              ariaLabel={`Planned for ${row.name}`}
              cents={row.plannedCents}
              onSave={(plannedCents) => onSave({ plannedCents })}
              onEnter={onAmountEnter}
              className="text-base sm:text-lg"
            />
          )}
        </div>
        <button
          onClick={onSelect}
          aria-label={`Details for ${row.name}`}
          data-item-amount
          className={`tabular w-[5.5rem] shrink-0 rounded px-1 py-1 text-right hover:underline sm:w-[6.5rem] ${second < 0 ? "text-error" : "text-ink"}`}
        >
          {formatCents(second)}
        </button>
        {!plannedLocked && <button
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          aria-label={confirming ? `Confirm delete ${row.name}` : `Delete ${row.name}`}
          className={`absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 transition ${
            confirming
              ? "bg-error px-2 text-xs font-semibold text-white opacity-100"
              : "text-muted opacity-0 hover:bg-error-subtle hover:text-error focus:opacity-100 group-hover/row:opacity-100"
          }`}
        >
          {confirming ? "Delete" : <Trash />}
        </button>}
      </div>
      <ProgressBar actual={row.actualCents} planned={row.plannedCents} />
    </div>
  );
}

// A new, not-yet-saved row. Enter on the name jumps to the amount; Enter on the amount saves
// and starts another new row, so you can type a whole group without the mouse.
interface DraftProps {
  onCreate: (name: string, plannedCents: number) => Promise<void>;
  onClose: () => void;
}

export function DraftRow({ onCreate, onClose }: DraftProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [cents, setCents] = useState(0);
  const [key, setKey] = useState(0); // remount inputs after each save

  async function save(keepGoing: boolean) {
    const trimmed = name.trim();
    if (!trimmed) return onClose();
    setName("");
    setCents(0);
    await onCreate(trimmed, cents);
    if (keepGoing) {
      setKey((k) => k + 1);
    } else {
      onClose();
    }
  }

  return (
    <div
      ref={rowRef}
      className="bg-white px-4 sm:px-6"
      onBlur={(e) => {
        // Clicking somewhere else entirely: save if there's a name, otherwise discard
        if (!rowRef.current?.contains(e.relatedTarget as Node)) void save(false);
      }}
    >
      <div key={key} className="flex items-center gap-2 py-3">
        <input
          ref={nameRef}
          autoFocus
          aria-label="New item name"
          placeholder="Item name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (name.trim()) amountRef.current?.focus();
            } else if (e.key === "Escape") onClose();
          }}
          className="min-w-0 flex-1 rounded border border-action bg-white px-1 py-1 text-base sm:text-lg outline-none ring-2 ring-action/15 placeholder:text-inactive"
        />
        <div className="w-24 shrink-0 sm:w-[7.5rem]">
          <input
            ref={amountRef}
            aria-label="New item planned amount"
            inputMode="decimal"
            placeholder="$0.00"
            onChange={(e) => {
              const v = e.target.value.replace(/[$,\s]/g, "");
              const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(v);
              setCents(m ? Number(m[1] || 0) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save(true);
              } else if (e.key === "Escape") onClose();
            }}
            className="tabular w-full rounded border border-strong bg-white px-1 py-1 text-right text-base sm:text-lg outline-none focus:border-action focus:ring-2 focus:ring-action/15 placeholder:text-inactive"
          />
        </div>
        <div className="w-[5.5rem] shrink-0 sm:w-[6.5rem]" />
      </div>
      <div className="h-1 w-full rounded bg-strong" />
    </div>
  );
}
