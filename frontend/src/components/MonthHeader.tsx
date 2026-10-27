import { useEffect, useRef, useState } from "react";
import { MONTH_NAMES, addMonths, type YearMonth } from "../dates";
import { ChevronDown, ChevronLeft, ChevronRight } from "./Icons";

interface Props {
  value: YearMonth;
  onChange: (ym: YearMonth) => void;
  existing: YearMonth[];
}

export default function MonthHeader({ value, onChange, existing }: Props) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(value.year);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPickerYear(value.year), [value.year, open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const has = (y: number, m: number) => existing.some((e) => e.year === y && e.month === m);

  return (
    <div className="flex items-center justify-between border-b border-line pb-3">
      <div ref={boxRef} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 rounded-md py-1 pr-3 text-2xl hover:bg-white/70"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="font-semibold">{MONTH_NAMES[value.month - 1]}</span>
          <span className="font-light text-subtle">{value.year}</span>
          <ChevronDown className="size-5 text-subtle" />
        </button>

        {open && (
          <div role="dialog" aria-label="Pick a month" className="absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl bg-white p-4 shadow-[0_8px_24px_rgba(31,36,38,0.14)]">
            <div className="mb-3 flex items-center justify-between">
              <button aria-label="Previous year" onClick={() => setPickerYear((y) => y - 1)} className="rounded p-1 text-action hover:bg-pressed">
                <ChevronLeft />
              </button>
              <span className="font-semibold">{pickerYear}</span>
              <button aria-label="Next year" onClick={() => setPickerYear((y) => y + 1)} className="rounded p-1 text-action hover:bg-pressed">
                <ChevronRight />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MONTH_NAMES.map((name, i) => {
                const m = i + 1;
                const selected = pickerYear === value.year && m === value.month;
                return (
                  <button
                    key={name}
                    onClick={() => {
                      onChange({ year: pickerYear, month: m });
                      setOpen(false);
                    }}
                    className={`relative rounded-lg py-2 text-sm ${
                      selected ? "bg-primary font-semibold text-white" : "hover:bg-pressed"
                    }`}
                  >
                    {name.slice(0, 3)}
                    {has(pickerYear, m) && !selected && (
                      <span className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-brand" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex overflow-hidden rounded-md border border-action/60">
        <button aria-label="Previous month" onClick={() => onChange(addMonths(value, -1))} className="p-1 text-action hover:bg-pressed">
          <ChevronLeft className="size-5" />
        </button>
        <span className="w-px bg-action/60" />
        <button aria-label="Next month" onClick={() => onChange(addMonths(value, 1))} className="p-1 text-action hover:bg-pressed">
          <ChevronRight className="size-5" />
        </button>
      </div>
    </div>
  );
}
