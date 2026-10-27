import { useRef, useState } from "react";
import { formatCents } from "../money";
import { InlineText, MoneyInput } from "./inputs";
import { Trash } from "./Icons";

export interface RowData {
  id: number;
  name: string;
  plannedCents: number;
  actualCents: number; // spent (expenses) or received (income)
}

export type SecondColumn = "actual" | "remaining";

interface Props {
  row: RowData;
  column: SecondColumn;
  onSave: (changes: { name?: string; plannedCents?: number }) => void;
  onDelete: () => void;
  onAmountEnter: () => void;
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

export default function ItemRow({ row, column, onSave, onDelete, onAmountEnter }: Props) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const second = secondValue(row, column);

  return (
    <div className="group/row relative bg-white px-4 sm:px-6">
      <div className="flex items-center gap-2 py-3">
        <InlineText
          value={row.name}
          ariaLabel="Item name"
          onSave={(name) => onSave({ name })}
          onEnter={() => amountRef.current?.focus()}
          className="flex-1 text-base sm:text-lg"
        />
        <div className="w-24 shrink-0 sm:w-[7.5rem]">
          <MoneyInput
            ref={amountRef}
            ariaLabel={`Planned for ${row.name}`}
            cents={row.plannedCents}
            onSave={(plannedCents) => onSave({ plannedCents })}
            onEnter={onAmountEnter}
            className="text-base sm:text-lg"
          />
        </div>
        <div className={`tabular w-[5.5rem] shrink-0 sm:w-[6.5rem] text-right ${second < 0 ? "text-error" : "text-ink"}`}>
          {formatCents(second)}
        </div>
        <button
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
        </button>
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
