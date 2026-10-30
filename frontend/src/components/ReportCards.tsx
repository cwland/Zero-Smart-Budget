import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { MONTH_NAMES, type YearMonth } from "../dates";
import { formatCents, formatWholeDollars } from "../money";
import { csvDollars, downloadCsv, Legend, Lines, SignedBars, TipRow, type Series } from "./charts";

// The extra Reports cards (beyond the four EveryDollar-style ones) and the shared card frame

export interface ReportData {
  months: YearMonth[];
  years: number[];
  spending: { year: number; month: number; group: string; item: string; cents: number }[];
  planned: { year: number; month: number; group: string; item: string; cents: number }[];
  income: { year: number; month: number; source: string; cents: number }[];
  merchants: { name: string; visits: number; cents: number; lastDate: string }[];
  funds: { id: number; name: string; kind: "sinking" | "goal"; targetCents: number | null; balances: number[] }[];
  unusual: { group: string; item: string; cents: number; usualCents: number; overCents: number; pct: number }[];
  aiAvailable: boolean;
}

export const select = "rounded-lg border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15 disabled:bg-page disabled:text-subtle";
export const monthName = (m: YearMonth) => `${MONTH_NAMES[m.month - 1]} ${m.year}`;
const ymText = (m: YearMonth) => `${m.year}-${String(m.month).padStart(2, "0")}`;
const empty = (msg: string) => <p className="flex min-h-48 items-center justify-center px-4 text-center text-subtle">{msg}</p>;

export function Card({ title, subtitle, onCsv, wide, children }: { title: string; subtitle?: ReactNode; onCsv?: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={`relative flex min-w-0 flex-col rounded-2xl bg-white p-5 sm:p-6 ${wide ? "lg:col-span-2" : ""}`}>
      <h2 className="text-center text-xl font-semibold">{title}</h2>
      {subtitle && <p className="mt-1 text-center text-sm text-subtle">{subtitle}</p>}
      {onCsv && (
        <button type="button" onClick={onCsv} title={`Download ${title} as a spreadsheet (CSV)`} aria-label={`Download ${title} as CSV`} className="absolute right-4 top-5 rounded-md px-2 py-1 text-sm font-semibold text-link hover:bg-pressed sm:right-5 sm:top-6">
          CSV
        </button>
      )}
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

// ---------- Planned vs. Spent ----------
export function PlannedVsSpent({ data, groups, fileTag }: { data: ReportData; groups: string[]; fileTag: string }) {
  const [group, setGroup] = useState("");
  useEffect(() => {
    if (group && !groups.includes(group)) setGroup("");
  }, [groups, group]);

  const rows = (() => {
    const m = new Map<string, { name: string; planned: number; spent: number }>();
    const nameOf = (r: { group: string; item: string }) => (group ? r.item : r.group);
    const keep = (r: { group: string }) => !group || r.group === group;
    for (const p of data.planned.filter(keep)) {
      const row = m.get(nameOf(p)) ?? { name: nameOf(p), planned: 0, spent: 0 };
      row.planned += p.cents;
      m.set(row.name, row);
    }
    for (const s of data.spending.filter(keep)) {
      const row = m.get(nameOf(s)) ?? { name: nameOf(s), planned: 0, spent: 0 };
      row.spent += s.cents;
      m.set(row.name, row);
    }
    return [...m.values()].filter((r) => r.planned || r.spent).sort((a, b) => b.planned - a.planned || b.spent - a.spent);
  })();
  const total = rows.reduce((t, r) => ({ planned: t.planned + r.planned, spent: t.spent + r.spent }), { planned: 0, spent: 0 });

  return (
    <Card
      title="Planned vs. Spent"
      subtitle="Did each part of the budget stay within its plan?"
      onCsv={() => downloadCsv(`planned-vs-spent-${fileTag}.csv`, [[group ? "Item" : "Group", "Planned", "Spent", "Left (negative = over)"], ...rows.map((r) => [r.name, csvDollars(r.planned), csvDollars(r.spent), csvDollars(r.planned - r.spent)])])}
    >
      <select aria-label="Planned vs. Spent group" value={group} onChange={(e) => setGroup(e.target.value)} className={`${select} mx-auto mb-4 w-full max-w-xs`}>
        <option value="">All Groups</option>
        {groups.map((g) => (
          <option key={g}>{g}</option>
        ))}
      </select>
      {rows.length === 0 ? (
        empty("Nothing planned or spent in this period")
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const over = r.spent > r.planned;
            const pct = r.planned > 0 ? Math.min(100, Math.max(0, (r.spent / r.planned) * 100)) : r.spent > 0 ? 100 : 0;
            return (
              <li key={r.name} className="py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                  <span className="tabular text-sm text-subtle">
                    {formatWholeDollars(r.spent)} of {formatWholeDollars(r.planned)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-strong">
                    <div className={`h-full rounded ${over ? "bg-error" : "bg-success"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className={`tabular w-24 text-right text-sm ${over ? "font-semibold text-error" : "text-subtle"}`}>
                    {over ? `${formatWholeDollars(r.spent - r.planned)} over` : `${formatWholeDollars(r.planned - r.spent)} left`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-auto pt-4 text-center text-sm text-subtle">
        Spent <span className="tabular font-semibold text-ink">{formatCents(total.spent)}</span> of <span className="tabular font-semibold text-ink">{formatCents(total.planned)}</span> planned
      </p>
    </Card>
  );
}

// ---------- Top Merchants ----------
export function TopMerchants({ data, fileTag }: { data: ReportData; fileTag: string }) {
  const [all, setAll] = useState(false);
  const list = all ? data.merchants : data.merchants.slice(0, 10);
  const top = data.merchants[0]?.cents ?? 1;
  return (
    <Card
      title="Top Merchants"
      subtitle="Where the money went, by store"
      onCsv={() => downloadCsv(`top-merchants-${fileTag}.csv`, [["Merchant", "Visits", "Total", "Average per visit", "Last visit"], ...data.merchants.map((m) => [m.name, m.visits, csvDollars(m.cents), csvDollars(m.visits ? Math.round(m.cents / m.visits) : m.cents), m.lastDate])])}
    >
      {list.length === 0 ? (
        empty("No spending in this period")
      ) : (
        <ol className="divide-y divide-line">
          {list.map((m, i) => (
            <li key={m.name + i} className="flex items-center gap-3 py-2.5">
              <span className="tabular w-5 shrink-0 text-right text-sm text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                  <span className="tabular font-semibold">{formatWholeDollars(m.cents)}</span>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-line">
                    <div className="h-full rounded bg-action" style={{ width: `${Math.max(2, (m.cents / top) * 100)}%` }} />
                  </div>
                  <span className="tabular w-36 text-right text-xs text-subtle">
                    {m.visits} {m.visits === 1 ? "visit" : "visits"}
                    {m.visits > 1 && ` · ${formatWholeDollars(Math.round(m.cents / m.visits))} avg`}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {data.merchants.length > 10 && (
        <button type="button" onClick={() => setAll(!all)} className="mx-auto mt-3 text-sm font-semibold text-link hover:underline">
          {all ? "Show top 10" : `Show all ${data.merchants.length}`}
        </button>
      )}
    </Card>
  );
}

// ---------- Savings Rate ----------
export function SavingsRate({ labels, fullLabels, incomeByMonth, spentByMonth, fileTag }: { labels: string[]; fullLabels: string[]; incomeByMonth: number[]; spentByMonth: number[]; fileTag: string }) {
  const income = incomeByMonth.reduce((a, b) => a + b, 0);
  const spent = spentByMonth.reduce((a, b) => a + b, 0);
  const kept = income - spent;
  const rate = income > 0 ? Math.round((kept / income) * 100) : null;
  const rates = incomeByMonth.map((inc, i) => (inc > 0 ? Math.round(((inc - spentByMonth[i]) / inc) * 1000) / 10 : null));
  return (
    <Card
      title="Savings Rate"
      subtitle="How much of what came in wasn't spent"
      onCsv={() => downloadCsv(`savings-rate-${fileTag}.csv`, [["Month", "Income", "Spent", "Kept", "Savings rate %"], ...fullLabels.map((l, i) => [l, csvDollars(incomeByMonth[i]), csvDollars(spentByMonth[i]), csvDollars(incomeByMonth[i] - spentByMonth[i]), rates[i] ?? ""])])}
    >
      {rate === null ? (
        empty("No income received in this period")
      ) : (
        <>
          <div className="mb-3 text-center">
            <p className={`tabular text-4xl font-semibold ${rate < 0 ? "text-error" : "text-success"}`}>{rate}%</p>
            <p className="mt-1 text-sm text-subtle">
              {kept >= 0 ? (
                <>
                  You kept <span className="tabular font-semibold text-ink">{formatWholeDollars(kept)}</span> of <span className="tabular font-semibold text-ink">{formatWholeDollars(income)}</span>
                </>
              ) : (
                <>
                  You spent <span className="tabular font-semibold text-error">{formatWholeDollars(-kept)}</span> more than came in
                </>
              )}
            </p>
          </div>
          <SignedBars
            labels={labels}
            fullLabels={fullLabels}
            values={rates}
            format={(v) => `${Math.round(v)}%`}
            colorFor={(v) => (v < 0 ? "var(--color-error)" : "var(--color-success)")}
            label="Savings rate by month"
            detail={(i) => (
              <>
                <TipRow label="Income" cents={incomeByMonth[i]} />
                <TipRow label="Spent" cents={spentByMonth[i]} />
                <TipRow label={`Kept (${rates[i]}%)`} cents={incomeByMonth[i] - spentByMonth[i]} bold />
              </>
            )}
          />
        </>
      )}
    </Card>
  );
}

// ---------- Fund & Goal Progress ----------
export function FundProgress({ data, labels, fullLabels, palette, fileTag }: { data: ReportData; labels: string[]; fullLabels: string[]; palette: string[]; fileTag: string }) {
  const funds = [...data.funds].sort((a, b) => b.balances[b.balances.length - 1] - a.balances[a.balances.length - 1]);
  const shown = funds.slice(0, palette.length);
  const series: Series[] = shown.map((f, i) => ({ key: String(f.id), label: f.name, color: palette[i], values: f.balances }));
  return (
    <Card
      title="Fund & Goal Progress"
      subtitle="Balance at the end of each month"
      onCsv={() => downloadCsv(`funds-${fileTag}.csv`, [["Month", ...funds.map((f) => f.name)], ...fullLabels.map((l, i) => [l, ...funds.map((f) => csvDollars(f.balances[i]))])])}
    >
      {funds.length === 0 ? (
        empty("No funds or goals yet. Add them on the Funds and Goals pages.")
      ) : (
        <>
          <Legend
            items={shown.map((f, i) => {
              const now = f.balances[f.balances.length - 1];
              return { key: String(f.id), label: f.name, color: palette[i], value: f.kind === "goal" && f.targetCents ? `${formatWholeDollars(now)} of ${formatWholeDollars(f.targetCents)}` : formatWholeDollars(now) };
            })}
          />
          <Lines labels={labels} fullLabels={fullLabels} series={series} avgs={[]} label="Fund balances by month" />
          {funds.length > shown.length && <p className="text-center text-xs text-subtle">Showing the {shown.length} biggest. The CSV has all {funds.length}.</p>}
        </>
      )}
    </Card>
  );
}

// ---------- Unusual Spending + AI summary ----------
function Bullets({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.every((l) => /^[-*•]\s/.test(l));
  return bullets ? (
    <ul className="list-disc space-y-1.5 pl-5">
      {lines.map((l, i) => (
        <li key={i}>{l.replace(/^[-*•]\s+/, "").replace(/\*\*/g, "")}</li>
      ))}
    </ul>
  ) : (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <p key={i}>{l.replace(/\*\*/g, "")}</p>
      ))}
    </div>
  );
}

export function UnusualSpending({ data, from, to, fileTag }: { data: ReportData; from: YearMonth; to: YearMonth; fileTag: string }) {
  const last = data.months[data.months.length - 1];
  const [summary, setSummary] = useState<{ text: string; service: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setSummary(null);
    setError("");
  }, [from.year, from.month, to.year, to.month]);

  const ask = async () => {
    setBusy(true);
    setError("");
    try {
      setSummary(await api<{ text: string; service: string }>("POST", "/api/reports/summary", { from: ymText(from), to: ymText(to) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      wide
      title="Unusual Spending"
      subtitle={`Items that cost a lot more than usual in ${monthName(last)}`}
      onCsv={() => downloadCsv(`unusual-spending-${fileTag}.csv`, [["Group", "Item", `${monthName(last)}`, "Usual month", "More than usual", "%"], ...data.unusual.map((u) => [u.group, u.item, csvDollars(u.cents), csvDollars(u.usualCents), csvDollars(u.overCents), u.pct])])}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {data.unusual.length === 0 ? (
            <p className="py-6 text-center text-subtle">
              Nothing stands out in {monthName(last)}. Every item is close to its usual amount (or there isn't enough history yet: it needs two earlier months in the period).
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {data.unusual.map((u) => (
                <li key={u.group + u.item} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{u.item}</p>
                    <p className="truncate text-sm text-subtle">
                      {u.group} · usually {formatWholeDollars(u.usualCents)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{formatWholeDollars(u.cents)}</p>
                    <p className="tabular text-sm font-semibold text-error">
                      +{formatWholeDollars(u.overCents)} ({u.pct}%)
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl bg-page p-4">
          <p className="font-semibold">AI summary of this period</p>
          {data.aiAvailable ? (
            <>
              {summary ? (
                <div className="mt-2 text-sm leading-relaxed">
                  <Bullets text={summary.text} />
                  <p className="mt-3 text-xs text-muted">Written by {summary.service}. Check the numbers above before acting on it.</p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-subtle">Your AI service reads this period's totals (no transaction details) and writes a few plain-English points.</p>
              )}
              {error && (
                <p role="alert" className="mt-2 text-sm text-error">
                  {error}
                </p>
              )}
              <button type="button" onClick={ask} disabled={busy} className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
                {busy ? "Writing…" : summary ? "Write it again" : "Summarize with AI"}
              </button>
            </>
          ) : (
            <p className="mt-1 text-sm text-subtle">
              Turn on AI in <a href="#/settings/ai" className="text-link hover:underline">Settings › AI</a> to get a short written summary of each period.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------- Cash Flow Calendar ----------
interface CashDay {
  date: string;
  inCents: number;
  outCents: number;
  items: { merchant: string; cents: number; type: "income" | "expense" }[];
}

export function CashFlowCalendar({ months }: { months: YearMonth[] }) {
  const [picked, setPicked] = useState(() => ymText(months[months.length - 1]));
  const [days, setDays] = useState<CashDay[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!months.some((m) => ymText(m) === picked)) setPicked(ymText(months[months.length - 1]));
  }, [months, picked]);
  useEffect(() => {
    setDays(null);
    setOpen(null);
    setError("");
    api<{ days: CashDay[] }>("GET", `/api/reports/cashflow?month=${picked}`)
      .then((r) => setDays(r.days))
      .catch((e) => setError((e as Error).message));
  }, [picked]);

  const year = Number(picked.slice(0, 4));
  const month = Number(picked.slice(5, 7));
  const daysIn = new Date(year, month, 0).getDate();
  const startDow = new Date(year, month - 1, 1).getDay();
  const byDate = new Map((days ?? []).map((d) => [d.date, d]));
  let running = 0;
  const cells = Array.from({ length: daysIn }, (_, i) => {
    const date = `${picked}-${String(i + 1).padStart(2, "0")}`;
    const d = byDate.get(date);
    running += (d?.inCents ?? 0) - (d?.outCents ?? 0);
    return { day: i + 1, date, d, net: running };
  });
  const totIn = (days ?? []).reduce((t, d) => t + d.inCents, 0);
  const totOut = (days ?? []).reduce((t, d) => t + d.outCents, 0);
  const openDay = cells.find((c) => c.date === open);
  const compact = (c: number) => (c >= 100000 ? `${(c / 100000).toFixed(c >= 1000000 ? 0 : 1)}k` : formatWholeDollars(c).replace("$", ""));

  return (
    <Card
      wide
      title="Cash Flow Calendar"
      subtitle="Money in and out each day, by the date it hit the account"
      onCsv={() => downloadCsv(`cash-flow-${picked}.csv`, [["Date", "Money in", "Money out", "Net so far"], ...cells.map((c) => [c.date, csvDollars(c.d?.inCents ?? 0), csvDollars(c.d?.outCents ?? 0), csvDollars(c.net)])])}
    >
      <div className="mb-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        <select aria-label="Cash flow month" value={picked} onChange={(e) => setPicked(e.target.value)} className={select}>
          {[...months].reverse().map((m) => (
            <option key={ymText(m)} value={ymText(m)}>
              {monthName(m)}
            </option>
          ))}
        </select>
        {days && (
          <p className="text-sm text-subtle">
            In <span className="tabular font-semibold text-success">{formatWholeDollars(totIn)}</span> · Out <span className="tabular font-semibold text-ink">{formatWholeDollars(totOut)}</span> · Net{" "}
            <span className={`tabular font-semibold ${totIn - totOut < 0 ? "text-error" : "text-ink"}`}>{formatWholeDollars(totIn - totOut)}</span>
          </p>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-center text-error">
          {error}
        </p>
      ) : !days ? (
        <div className="h-72" aria-busy="true" />
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase text-muted" aria-hidden>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <span key={d} className="py-1">
                <span className="sm:hidden">{d[0]}</span>
                <span className="hidden sm:inline">{d}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: startDow }, (_, i) => (
              <span key={`pad${i}`} />
            ))}
            {cells.map((c) => (
              <button
                key={c.date}
                type="button"
                onClick={() => setOpen(open === c.date ? null : c.date)}
                aria-label={`${MONTH_NAMES[month - 1]} ${c.day}: in ${formatCents(c.d?.inCents ?? 0)}, out ${formatCents(c.d?.outCents ?? 0)}, net so far ${formatCents(c.net)}`}
                aria-pressed={open === c.date}
                className={`flex min-h-16 flex-col rounded-lg border p-1 text-left text-[11px] leading-tight sm:min-h-20 sm:p-1.5 sm:text-xs ${open === c.date ? "border-action bg-active" : "border-line hover:bg-pressed"}`}
              >
                <span className="font-semibold text-subtle">{c.day}</span>
                {c.d?.inCents ? <span className="tabular truncate font-semibold text-success">+{compact(c.d.inCents)}</span> : null}
                {c.d?.outCents ? <span className="tabular truncate text-ink">−{compact(c.d.outCents)}</span> : null}
                <span className={`tabular mt-auto hidden truncate text-muted sm:block ${c.net < 0 ? "!text-error" : ""}`}>{c.d || c.day === 1 ? `= ${formatWholeDollars(c.net)}` : ""}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-xs text-muted">
            <span className="hidden sm:inline">"=" is the month's net so far (money in minus money out). </span>Tap a day to see its transactions.
          </p>
          {openDay && (
            <div className="mt-4 rounded-xl bg-page p-4">
              <p className="font-semibold">
                {MONTH_NAMES[month - 1]} {openDay.day}
              </p>
              {!openDay.d ? (
                <p className="mt-1 text-sm text-subtle">No transactions this day.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line text-sm">
                  {openDay.d.items.map((it, i) => (
                    <li key={i} className="flex gap-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate">{it.merchant}</span>
                      <span className={`tabular ${it.type === "income" ? "font-semibold text-success" : ""}`}>
                        {it.type === "income" ? "+" : "−"}
                        {formatCents(it.cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
