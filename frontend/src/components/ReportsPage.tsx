import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { addMonths, currentYearMonth, MONTH_NAMES, type YearMonth } from "../dates";
import { formatCents, formatWholeDollars } from "../money";
import { useTheme } from "../themes";
import { csvDollars, downloadCsv, Legend, Lines, Ring, StackedBars, type Series } from "./charts";
import { Card, CashFlowCalendar, FundProgress, PlannedVsSpent, SavingsRate, select, TopMerchants, UnusualSpending, type ReportData } from "./ReportCards";

// Reports: where the money went over a period. One date filter sets the period for every card.

type RangeId = "ytd" | "3" | "6" | "9" | "12" | `y${number}`;
const RANGE_KEY = "zsb-report-range";

function rangeMonths(id: RangeId): { from: YearMonth; to: YearMonth } {
  const now = currentYearMonth();
  if (id === "ytd") return { from: { year: now.year, month: 1 }, to: now };
  if (id.startsWith("y")) {
    const year = Number(id.slice(1));
    return { from: { year, month: 1 }, to: { year, month: 12 } };
  }
  return { from: addMonths(now, -(Number(id) - 1)), to: now };
}

// "Jan–Oct" (just "Jan" in January)
function thisYearSpan() {
  const m = currentYearMonth().month;
  const short = (n: number) => MONTH_NAMES[n - 1].slice(0, 3);
  return m === 1 ? short(1) : `${short(1)}–${short(m)}`;
}

function rangeLabel(id: RangeId) {
  if (id === "ytd") return "this year";
  if (id.startsWith("y")) return id.slice(1);
  return `past ${id} months`;
}

const ymParam = ({ year, month }: YearMonth) => `${year}-${String(month).padStart(2, "0")}`;
const key = (year: number, month: number) => year * 12 + month - 1;
const sortByTotal = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const OTHER = "Other";
// Biggest first, "Other" last, so legends read in the same order as the Spending Totals list
const bySize = (series: Series[]) =>
  series.sort((a, b) => (a.key === OTHER ? 1 : b.key === OTHER ? -1 : b.values.reduce((t, v) => t + v, 0) - a.values.reduce((t, v) => t + v, 0)));

// Colors follow the name: the biggest gets the first theme color and so on. The theme has 12
// colors, so anything past the 11th folds into "Other" (gray) instead of reusing a color.
function colorMap(names: string[], palette: string[], other: string) {
  const m = new Map<string, string>();
  names.forEach((n, i) => m.set(n, i < palette.length - 1 ? palette[i] : other));
  return m;
}
const foldName = (names: string[], palette: string[]) => {
  const keep = new Set(names.slice(0, palette.length - 1));
  return (n: string) => (keep.has(n) ? n : OTHER);
};

export default function ReportsPage() {
  const palette = useTheme().groups;
  const otherColor = "var(--color-inactive)";
  const [range, setRange] = useState<RangeId>(() => {
    try {
      return (localStorage.getItem(RANGE_KEY) as RangeId) || "ytd";
    } catch {
      return "ytd";
    }
  });
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [totalsGroup, setTotalsGroup] = useState("");
  const [detailGroup, setDetailGroup] = useState("");
  const [detailItem, setDetailItem] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      /* private window */
    }
    const { from, to } = rangeMonths(range);
    setError("");
    api<ReportData>("GET", `/api/reports?from=${ymParam(from)}&to=${ymParam(to)}`)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [range]);

  const now = currentYearMonth();
  const pastYears = (data?.years ?? []).filter((y) => y < now.year).reverse();

  const r = useMemo(() => {
    if (!data) return null;
    const idx = new Map(data.months.map((m, i) => [key(m.year, m.month), i]));
    const spansYears = data.months[0].year !== data.months[data.months.length - 1].year;
    const labels = data.months.map((m, i) => MONTH_NAMES[m.month - 1].slice(0, 3) + (spansYears && (i === 0 || m.month === 1) ? `\n${m.year}` : ""));
    const fullLabels = data.months.map((m) => `${MONTH_NAMES[m.month - 1]} ${m.year}`);
    const zeros = () => data.months.map(() => 0);

    // Spending by group, and items within each group
    const groupTotals = new Map<string, number>();
    const itemTotals = new Map<string, Map<string, number>>();
    for (const s of data.spending) {
      groupTotals.set(s.group, (groupTotals.get(s.group) ?? 0) + s.cents);
      const items = itemTotals.get(s.group) ?? new Map<string, number>();
      items.set(s.item, (items.get(s.item) ?? 0) + s.cents);
      itemTotals.set(s.group, items);
    }
    const groups = sortByTotal(groupTotals);
    const groupColors = colorMap(groups, palette, otherColor);
    const itemsOf = (g: string) => sortByTotal(itemTotals.get(g) ?? new Map());

    const sources = new Map<string, number>();
    for (const i of data.income) sources.set(i.source, (sources.get(i.source) ?? 0) + i.cents);
    const sourceNames = sortByTotal(sources);

    const spentByMonth = zeros();
    for (const s of data.spending) spentByMonth[idx.get(key(s.year, s.month))!] += s.cents;
    const incomeByMonth = zeros();
    for (const i of data.income) incomeByMonth[idx.get(key(i.year, i.month))!] += i.cents;

    return { idx, labels, fullLabels, zeros, groups, groupTotals, groupColors, itemsOf, itemTotals, sources, sourceNames, spentByMonth, incomeByMonth };
  }, [data, palette, otherColor]);

  // Forget a picked group or item that isn't in the new period
  useEffect(() => {
    if (!r) return;
    if (totalsGroup && !r.groups.includes(totalsGroup)) setTotalsGroup("");
    if (detailGroup && !r.groups.includes(detailGroup)) {
      setDetailGroup("");
      setDetailItem("");
    } else if (detailItem && !r.itemsOf(detailGroup).includes(detailItem)) setDetailItem("");
  }, [r, totalsGroup, detailGroup, detailItem]);

  if (error) return <Page range={range} setRange={setRange} pastYears={pastYears}><p role="alert" className="rounded-2xl bg-white p-6 text-error">{error}</p></Page>;
  if (!data || !r) return <Page range={range} setRange={setRange} pastYears={pastYears}><div className="h-96" aria-busy="true" /></Page>;

  const average = (values: number[]) => {
    const active = values.filter((v) => v !== 0);
    return active.length ? Math.round(active.reduce((a, b) => a + b, 0) / active.length) : 0;
  };
  const avgColor = "var(--color-ink)";

  // ----- Spending Totals -----
  const totalsSlices = (() => {
    if (!totalsGroup) {
      const fold = foldName(r.groups, palette);
      const m = new Map<string, number>();
      for (const g of r.groups) m.set(fold(g), (m.get(fold(g)) ?? 0) + (r.groupTotals.get(g) ?? 0));
      return [...m.entries()].map(([name, cents]) => ({ key: name, label: name, color: name === OTHER ? otherColor : r.groupColors.get(name)!, cents }));
    }
    const items = r.itemsOf(totalsGroup);
    const colors = colorMap(items, palette, otherColor);
    const fold = foldName(items, palette);
    const m = new Map<string, number>();
    for (const it of items) m.set(fold(it), (m.get(fold(it)) ?? 0) + (r.itemTotals.get(totalsGroup)!.get(it) ?? 0));
    return [...m.entries()].map(([name, cents]) => ({ key: name, label: name, color: name === OTHER ? otherColor : colors.get(name)!, cents }));
  })().filter((s) => s.cents > 0);
  const totalsSum = totalsSlices.reduce((t, s) => t + s.cents, 0);

  // ----- Spending Details -----
  const detailSeries: Series[] = bySize((() => {
    if (!detailGroup) {
      const fold = foldName(r.groups, palette);
      const m = new Map<string, number[]>();
      for (const s of data.spending) {
        const name = fold(s.group);
        const values = m.get(name) ?? r.zeros();
        values[r.idx.get(key(s.year, s.month))!] += s.cents;
        m.set(name, values);
      }
      return [...m.entries()].map(([name, values]) => ({ key: name, label: name, color: name === OTHER ? otherColor : r.groupColors.get(name)!, values }));
    }
    const items = r.itemsOf(detailGroup);
    const colors = colorMap(items, palette, otherColor);
    const fold = foldName(items, palette);
    const m = new Map<string, number[]>();
    for (const s of data.spending) {
      if (s.group !== detailGroup || (detailItem && s.item !== detailItem)) continue;
      const name = detailItem ? s.item : fold(s.item);
      const values = m.get(name) ?? r.zeros();
      values[r.idx.get(key(s.year, s.month))!] += s.cents;
      m.set(name, values);
    }
    return [...m.entries()].map(([name, values]) => ({
      key: name,
      label: name,
      color: detailItem ? r.groupColors.get(detailGroup)! : name === OTHER ? otherColor : colors.get(name)!,
      values,
    }));
  })());
  const detailByMonth = r.zeros().map((_, i) => detailSeries.reduce((t, s) => t + s.values[i], 0));

  // ----- Monthly Income -----
  const sourceColors = colorMap(r.sourceNames, palette, otherColor);
  const foldSource = foldName(r.sourceNames, palette);
  const incomeSeries: Series[] = bySize((() => {
    const m = new Map<string, number[]>();
    for (const i of data.income) {
      const name = foldSource(i.source);
      const values = m.get(name) ?? r.zeros();
      values[r.idx.get(key(i.year, i.month))!] += i.cents;
      m.set(name, values);
    }
    return [...m.entries()].map(([name, values]) => ({ key: name, label: name, color: name === OTHER ? otherColor : sourceColors.get(name)!, values }));
  })());

  const incomeTotal = r.incomeByMonth.reduce((a, b) => a + b, 0);
  const spentTotal = r.spentByMonth.reduce((a, b) => a + b, 0);
  const incomeColor = "var(--color-success)";
  const spentColor = palette[2];
  const { from, to } = rangeMonths(range);
  const fileTag = range === "ytd" ? `this-year-${now.year}` : range.startsWith("y") ? range.slice(1) : `past-${range}-months`;
  const seriesCsv = (name: string, series: Series[]) =>
    downloadCsv(`${name}-${fileTag}.csv`, [["Month", ...series.map((x) => x.label), "Total"], ...r.fullLabels.map((l, i) => [l, ...series.map((x) => csvDollars(x.values[i])), csvDollars(series.reduce((t, x) => t + x.values[i], 0))])]);
  const empty = (msg: string) => <p className="flex h-64 items-center justify-center text-center text-subtle">{msg}</p>;

  return (
    <Page range={range} setRange={setRange} pastYears={pastYears}>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Spending Totals" onCsv={() => downloadCsv(`spending-totals-${fileTag}.csv`, [[totalsGroup ? "Item" : "Group", "Spent", "%"], ...totalsSlices.map((x) => [x.label, csvDollars(x.cents), totalsSum ? Math.round((x.cents / totalsSum) * 1000) / 10 : 0])])}>
          <select aria-label="Spending Totals group" value={totalsGroup} onChange={(e) => setTotalsGroup(e.target.value)} className={`${select} mx-auto mb-5 w-full max-w-xs`}>
            <option value="">All Groups</option>
            {r.groups.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          {totalsSlices.length === 0 ? (
            empty("No spending in this period")
          ) : (
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center">
              <Ring slices={totalsSlices} centerLabel="Total spent" centerValue={formatWholeDollars(totalsSum)} label={`Spending by ${totalsGroup ? "item" : "group"}`} />
              <ul className="w-full max-w-60 space-y-1.5 text-sm">
                {totalsSlices.map((s) => (
                  <li key={s.key} className="flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <span className="tabular">{formatWholeDollars(s.cents)}</span>
                    <span className="tabular w-10 text-right text-subtle">{Math.round((s.cents / totalsSum) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-auto pt-5 text-center text-sm text-subtle">
            <span className="tabular font-semibold text-ink">{formatCents(totalsSum)}</span> Total Spent{totalsGroup ? ` on ${totalsGroup}` : ""} ({rangeLabel(range)})
          </p>
        </Card>

        <Card title="Spending Details" onCsv={() => seriesCsv("spending-details", detailSeries)}>
          <div className="mx-auto mb-5 grid w-full max-w-sm grid-cols-2 gap-3">
            <select
              aria-label="Spending Details group"
              value={detailGroup}
              onChange={(e) => {
                setDetailGroup(e.target.value);
                setDetailItem("");
              }}
              className={select}
            >
              <option value="">All Groups</option>
              {r.groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <select aria-label="Spending Details item" value={detailItem} onChange={(e) => setDetailItem(e.target.value)} disabled={!detailGroup} className={select}>
              <option value="">All Items</option>
              {detailGroup && r.itemsOf(detailGroup).map((it) => <option key={it}>{it}</option>)}
            </select>
          </div>
          {detailSeries.length === 0 ? (
            empty("No spending in this period")
          ) : (
            <>
              {detailSeries.length > 1 && <Legend items={detailSeries} />}
              <StackedBars labels={r.labels} fullLabels={r.fullLabels} series={detailSeries} avg={{ cents: average(detailByMonth), label: "avg", color: avgColor }} label="Spending by month" />
            </>
          )}
        </Card>

        <Card title="Monthly Income" onCsv={() => seriesCsv("monthly-income", incomeSeries)}>
          {incomeSeries.length === 0 ? (
            empty("No income received in this period")
          ) : (
            <>
              <Legend items={incomeSeries} />
              <StackedBars labels={r.labels} fullLabels={r.fullLabels} series={incomeSeries} avg={{ cents: average(r.incomeByMonth), label: "avg", color: avgColor }} label="Income by month" />
            </>
          )}
        </Card>

        <Card title="Income vs. Spent" onCsv={() => downloadCsv(`income-vs-spent-${fileTag}.csv`, [["Month", "Income", "Spent"], ...r.fullLabels.map((l, i) => [l, csvDollars(r.incomeByMonth[i]), csvDollars(r.spentByMonth[i])])])}>
          {incomeTotal === 0 && spentTotal === 0 ? (
            empty("Nothing received or spent in this period")
          ) : (
            <>
              <Legend
                items={[
                  { key: "income", label: "Income", color: incomeColor, value: formatWholeDollars(incomeTotal) },
                  { key: "spent", label: "Spent", color: spentColor, value: <span className={spentTotal > incomeTotal ? "text-error" : ""}>{formatWholeDollars(spentTotal)}</span> },
                ]}
              />
              <Lines
                labels={r.labels}
                fullLabels={r.fullLabels}
                series={[
                  { key: "income", label: "Income", color: incomeColor, values: r.incomeByMonth },
                  { key: "spent", label: "Spent", color: spentColor, values: r.spentByMonth },
                ]}
                avgs={[
                  { cents: average(r.incomeByMonth), label: "avg Income", color: incomeColor },
                  { cents: average(r.spentByMonth), label: "avg Spent", color: spentColor },
                ]}
                label="Income and spending by month"
              />
            </>
          )}
        </Card>

        <PlannedVsSpent data={data} groups={r.groups} fileTag={fileTag} />
        <TopMerchants data={data} fileTag={fileTag} />
        <SavingsRate labels={r.labels} fullLabels={r.fullLabels} incomeByMonth={r.incomeByMonth} spentByMonth={r.spentByMonth} fileTag={fileTag} />
        <FundProgress data={data} labels={r.labels} fullLabels={r.fullLabels} palette={palette} fileTag={fileTag} />
        <UnusualSpending data={data} from={from} to={to} fileTag={fileTag} />
        <CashFlowCalendar months={data.months} />
      </div>
    </Page>
  );
}

function Page({ range, setRange, pastYears, children }: { range: RangeId; setRange: (r: RangeId) => void; pastYears: number[]; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value as RangeId)} className={`${select} min-w-52`}>
          <option value="ytd">This year ({thisYearSpan()})</option>
          <option value="3">Past 3 months</option>
          <option value="6">Past 6 months</option>
          <option value="9">Past 9 months</option>
          <option value="12">Past 12 months</option>
          {pastYears.map((y) => (
            <option key={y} value={`y${y}`}>
              {y}
            </option>
          ))}
          {/* a saved past year that has no budget any more */}
          {range.startsWith("y") && !pastYears.includes(Number(range.slice(1))) && <option value={range}>{range.slice(1)}</option>}
        </select>
      </div>
      {children}
    </div>
  );
}
