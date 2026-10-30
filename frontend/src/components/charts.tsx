import { useState, type ReactNode } from "react";
import { formatCents, formatWholeDollars } from "../money";

// Small hand-drawn SVG charts for the Reports page. Values are cents. Colors come from the theme.

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[]; // one per x label
}

export interface AvgLine {
  cents: number;
  label: string; // "avg", "avg Income"
  color: string;
}

const W = 560;
const H = 260;
const PAD = { left: 56, right: 12, top: 22, bottom: 34 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

// A round top value and four evenly spaced gridlines
function niceScale(maxCents: number) {
  const max = Math.max(maxCents / 100, 1);
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 4 >= max) ?? 10 * mag;
  return { top: step * 4 * 100, ticks: [0, 1, 2, 3, 4].map((i) => i * step * 100) };
}

const axisLabel = (cents: number) => formatWholeDollars(cents);

// Hover box next to the pointer, kept inside the chart
function Tooltip({ xPct, children }: { xPct: number; children: ReactNode }) {
  const right = xPct > 55;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-line bg-white px-3 py-2 text-sm shadow-[0_8px_24px_rgba(31,36,38,0.15)]"
      style={right ? { right: `${100 - xPct + 3}%` } : { left: `${xPct + 3}%` }}
    >
      {children}
    </div>
  );
}

function TipRow({ color, label, cents, bold }: { color?: string; label: string; cents: number; bold?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${bold ? "mt-1 border-t border-line pt-1 font-semibold" : ""}`}>
      {color ? <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} /> : <span className="w-2.5" />}
      <span className="min-w-0 flex-1 truncate text-subtle">{label}</span>
      <span className="tabular">{formatCents(cents)}</span>
    </div>
  );
}

function Grid({ ticks, top }: { ticks: number[]; top: number }) {
  return (
    <g>
      {ticks.map((t) => {
        const y = PAD.top + plotH - (t / top) * plotH;
        return (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--color-line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize="12" fill="var(--color-muted)">
              {axisLabel(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ labels }: { labels: string[] }) {
  // "Jan\n2026": the second line (the year) only shows under the first month and each January
  const slot = plotW / labels.length;
  const every = labels.length > 18 ? 3 : labels.length > 12 ? 2 : 1;
  return (
    <g>
      {labels.map((l, i) => {
        if (i % every) return null;
        const [m, y] = l.split("\n");
        const x = PAD.left + slot * (i + 0.5);
        return (
          <text key={i} x={x} y={H - 14} textAnchor="middle" fontSize="12" fill="var(--color-muted)">
            {m}
            {y && (
              <tspan x={x} dy={13} fontSize="11">
                {y}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

// Dotted average line, labelled at its right end ("$2,788 avg")
function Average({ line, top, nudge = 0 }: { line: AvgLine; top: number; nudge?: number }) {
  if (line.cents <= 0) return null;
  const y = PAD.top + plotH - (Math.min(line.cents, top) / top) * plotH;
  return (
    <g className="pointer-events-none">
      <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={line.color} strokeWidth={2} strokeDasharray="2 5" strokeLinecap="round" />
      <text
        x={W - PAD.right}
        y={y - 6 + nudge}
        textAnchor="end"
        fontSize="12"
        fontWeight="600"
        fill={line.color}
        stroke="#fff"
        strokeWidth={4}
        strokeLinejoin="round"
        style={{ paintOrder: "stroke" }}
      >
        {formatWholeDollars(line.cents)} {line.label}
      </text>
    </g>
  );
}

const roundedTop = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
};

// Stacked bars, one per month. Negative amounts (more refunds than spending) draw as zero.
export function StackedBars({ labels, fullLabels, series, avg, label }: { labels: string[]; fullLabels: string[]; series: Series[]; avg?: AvgLine; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = labels.map((_, i) => series.reduce((t, s) => t + Math.max(0, s.values[i]), 0));
  const { top, ticks } = niceScale(Math.max(...totals, avg?.cents ?? 0));
  const slot = plotW / labels.length;
  const barW = Math.min(36, slot * 0.6);
  const scale = (c: number) => (c / top) * plotH;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        <Grid ticks={ticks} top={top} />
        {hover !== null && <rect x={PAD.left + slot * hover} y={PAD.top} width={slot} height={plotH} fill="var(--color-pressed)" />}
        {labels.map((_, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          let y = PAD.top + plotH;
          const parts = series.map((s) => ({ s, v: Math.max(0, s.values[i]) })).filter((p) => p.v > 0);
          return (
            <g key={i}>
              {parts.map((p, j) => {
                const h = scale(p.v);
                y -= h;
                const gap = j < parts.length - 1 && h > 3 ? 2 : 0; // 2px gap between segments
                const isTop = j === parts.length - 1;
                return isTop ? (
                  <path key={p.s.key} d={roundedTop(x, y, barW, h, 4)} fill={p.s.color} />
                ) : (
                  <rect key={p.s.key} x={x} y={y + gap} width={barW} height={Math.max(0, h - gap)} fill={p.s.color} />
                );
              })}
              {/* bigger hover target than the bar */}
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--color-strong)" strokeWidth={1} />
        {avg && <Average line={avg} top={top} />}
        <XLabels labels={labels} />
      </svg>
      {hover !== null && (
        <Tooltip xPct={((PAD.left + slot * (hover + 0.5)) / W) * 100}>
          <p className="mb-1 font-semibold">{fullLabels[hover]}</p>
          {series
            .filter((s) => s.values[hover] !== 0)
            .map((s) => (
              <TipRow key={s.key} color={s.color} label={s.label} cents={s.values[hover]} />
            ))}
          {series.length > 1 && <TipRow label="Total" cents={totals[hover]} bold />}
          {series.length > 0 && series.every((s) => s.values[hover] === 0) && <p className="text-subtle">Nothing this month</p>}
        </Tooltip>
      )}
    </div>
  );
}

// Lines that share one dollar axis (Income vs. Spent)
export function Lines({ labels, fullLabels, series, avgs, label }: { labels: string[]; fullLabels: string[]; series: Series[]; avgs: AvgLine[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = niceScale(Math.max(...series.flatMap((s) => s.values), ...avgs.map((a) => a.cents)));
  const slot = plotW / labels.length;
  const xAt = (i: number) => PAD.left + slot * (i + 0.5);
  const yAt = (c: number) => PAD.top + plotH - (Math.max(0, c) / top) * plotH;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        <Grid ticks={ticks} top={top} />
        {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--color-strong)" strokeWidth={1} />}
        {avgs.map((a, i) => {
          const other = avgs[1 - i];
          const close = other && Math.abs(((a.cents - other.cents) / top) * plotH) < 18;
          return <Average key={a.label} line={a} top={top} nudge={close && a.cents < other.cents ? 22 : 0} />;
        })}
        {series.map((s) => (
          <g key={s.key}>
            <polyline points={s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={xAt(i)} cy={yAt(v)} r={hover === i ? 5 : 4} fill="#fff" stroke={s.color} strokeWidth={2} />
            ))}
          </g>
        ))}
        {labels.map((_, i) => (
          <rect key={i} x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
        ))}
        <XLabels labels={labels} />
      </svg>
      {hover !== null && (
        <Tooltip xPct={(xAt(hover) / W) * 100}>
          <p className="mb-1 font-semibold">{fullLabels[hover]}</p>
          {series.map((s) => (
            <TipRow key={s.key} color={s.color} label={s.label} cents={s.values[hover]} />
          ))}
        </Tooltip>
      )}
    </div>
  );
}

// Pie (as a ring, like the budget's summary chart) with the total in the middle
export function Ring({ slices, centerLabel, centerValue, label }: { slices: { key: string; label: string; color: string; cents: number }[]; centerLabel: string; centerValue: string; label: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const r = 70;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((t, s) => t + Math.max(0, s.cents), 0);
  const shown = slices.find((s) => s.key === hover);
  let offset = 0;
  return (
    <div className="relative mx-auto size-52" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 180 180" className="size-full -rotate-90" role="img" aria-label={label}>
        <circle cx="90" cy="90" r={r} fill="none" stroke="var(--color-line)" strokeWidth="22" />
        {total > 0 &&
          slices.map((s) => {
            const len = (Math.max(0, s.cents) / total) * c;
            const gap = slices.length > 1 && len > 3 ? 1.5 : 0;
            const seg = (
              <circle
                key={s.key}
                cx="90"
                cy="90"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={hover === s.key ? 26 : 22}
                strokeDasharray={`${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(s.key)}
                onClick={() => setHover(s.key)}
              />
            );
            offset += len;
            return seg;
          })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
        <span className="max-w-full truncate text-xs uppercase tracking-wide text-subtle">{shown ? shown.label : centerLabel}</span>
        <span className="tabular text-2xl font-semibold">{shown ? formatWholeDollars(shown.cents) : centerValue}</span>
        {shown && total > 0 && <span className="text-sm text-subtle">{Math.round((shown.cents / total) * 100)}%</span>}
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { key: string; label: string; color: string; value?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: it.color }} />
          <span className="text-subtle">{it.label}</span>
          {it.value !== undefined && <span className="font-semibold text-ink">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}
