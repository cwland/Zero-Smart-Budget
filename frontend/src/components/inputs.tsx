import { forwardRef, useEffect, useState, type KeyboardEvent } from "react";
import { centsToInput, formatCents, parseMoney } from "../money";

// Text that looks like plain text until you click it. Saves on blur or Enter.
interface InlineTextProps {
  value: string;
  onSave: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  allowEmpty?: boolean;
  onChangeText?: (value: string) => void;
  onEscape?: () => void;
  size?: number;
}

export const InlineText = forwardRef<HTMLInputElement, InlineTextProps>(function InlineText(
  { value, onSave, onEnter, placeholder, className = "", autoFocus, ariaLabel, allowEmpty, onChangeText, onEscape, size },
  ref
) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  function commit() {
    const trimmed = text.trim();
    if (!trimmed && !allowEmpty) return setText(value);
    if (trimmed !== value) onSave(trimmed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      onEnter ? onEnter() : e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setText(value);
      onEscape?.();
      e.currentTarget.blur();
    }
  }

  return (
    <input
      ref={ref}
      value={text}
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoFocus={autoFocus}
      size={size}
      onChange={(e) => {
        setText(e.target.value);
        onChangeText?.(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={`min-w-0 rounded border border-transparent bg-transparent px-1 py-1 outline-none hover:border-strong focus:border-action focus:bg-white focus:ring-2 focus:ring-action/15 ${className}`}
    />
  );
});

// Money box: shows "$1,234.56"; while editing shows "1234.56". Saves on blur or Enter.
interface MoneyInputProps {
  cents: number;
  onSave: (cents: number) => void;
  onEnter?: () => void;
  className?: string;
  ariaLabel?: string;
  onChangeCents?: (cents: number | null) => void;
  onEscape?: () => void;
}

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { cents, onSave, onEnter, className = "", ariaLabel, onChangeCents, onEscape },
  ref
) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [startText, setStartText] = useState("");

  function commit() {
    if (!editing) return;
    setEditing(false);
    if (text === startText) return; // nothing typed: never overwrite the saved amount
    const parsed = parseMoney(text);
    if (parsed !== null && parsed !== cents) onSave(parsed);
  }

  return (
    <input
      ref={ref}
      inputMode="decimal"
      aria-label={ariaLabel}
      value={editing ? text : formatCents(cents)}
      onFocus={(e) => {
        const initial = centsToInput(cents);
        setEditing(true);
        setText(initial);
        setStartText(initial);
        const el = e.currentTarget;
        // select() would pull focus back if the user already moved on, so only select while still focused
        requestAnimationFrame(() => {
          if (document.activeElement === el) el.select();
        });
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChangeCents?.(parseMoney(e.target.value));
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          onEnter ? onEnter() : e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setEditing(false);
          onEscape?.();
          e.currentTarget.blur();
        }
      }}
      className={`tabular w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-1 text-right text-action outline-none hover:border-strong focus:border-action focus:bg-white focus:text-ink focus:ring-2 focus:ring-action/15 ${className}`}
    />
  );
});
