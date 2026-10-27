// All money is integer cents. These helpers only convert for display/input.

const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const wholeFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatCents(cents: number) {
  return formatter.format(cents / 100);
}

export function formatWholeDollars(cents: number) {
  return wholeFormatter.format(Math.round(cents / 100));
}

// For an input box while editing: 123456 -> "1234.56", 0 -> ""
export function centsToInput(cents: number) {
  if (!cents) return "";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

// Parse what the user typed. Accepts "$1,234.5", "12", ".99". Returns null if invalid.
// Uses string math (not floats) so cents never drift.
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return null;
  const dollars = Number(match[1] || "0");
  const cents = Number((match[2] ?? "").padEnd(2, "0") || "0");
  return dollars * 100 + cents;
}
