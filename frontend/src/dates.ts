export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export function currentYearMonth(): YearMonth {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function addMonths({ year, month }: YearMonth, delta: number): YearMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export const monthLabel = ({ year, month }: YearMonth) => `${MONTH_NAMES[month - 1]} ${year}`;

const pad = (n: number) => String(n).padStart(2, "0");

export function monthBounds({ year, month }: YearMonth) {
  const last = new Date(year, month, 0).getDate();
  return { min: `${year}-${pad(month)}-01`, max: `${year}-${pad(month)}-${pad(last)}` };
}

// Today if it's inside the month, otherwise the 1st of that month
export function defaultDateFor(ym: YearMonth) {
  const now = new Date();
  if (now.getFullYear() === ym.year && now.getMonth() + 1 === ym.month) {
    return `${ym.year}-${pad(ym.month)}-${pad(now.getDate())}`;
  }
  return monthBounds(ym).min;
}

// "2026-10-05" -> "Oct 5"
export function shortDate(iso: string) {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`;
}
