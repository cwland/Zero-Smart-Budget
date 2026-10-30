import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cashFlow, reportData, unusualSpending, ymIndex } from "../lib/reports.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { AiError } from "../lib/ai.js";
import { monthName as label } from "../lib/monthClose.js";

const ym = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM")
  .transform((v) => ({ year: Number(v.slice(0, 4)), month: Number(v.slice(5, 7)) }))
  .refine((v) => v.month >= 1 && v.month <= 12, "Not a real month");
const range = z.object({ from: ym, to: ym }).refine((r) => ymIndex(r.from) <= ymIndex(r.to), "The start month is after the end month").refine((r) => ymIndex(r.to) - ymIndex(r.from) <= 120, "Pick ten years or less");

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const SUMMARY_SYSTEM = `You write a short, friendly summary of someone's household budget for a period.
Use plain words and real numbers from the data. 3 to 5 short bullet points, each starting with "- ".
Cover: how spending compared to income, the biggest spending areas, anything that changed a lot or
cost more than usual, and one practical suggestion. No greeting, no headings, no advice to see a
professional. Under 120 words.`;

export default async function reportRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/api/reports", async (req) => {
    const q = range.parse(req.query);
    const data = await reportData(db, q.from, q.to);
    const ai = await app.ai.active();
    return { ...data, unusual: unusualSpending(data), aiAvailable: !!ai };
  });

  app.get("/api/reports/cashflow", async (req) => {
    const q = z.object({ month: ym }).parse(req.query);
    return cashFlow(db, q.month);
  });

  // A few sentences about the period from your AI service (Settings › AI)
  app.post("/api/reports/summary", async (req) => {
    const q = range.parse(req.body ?? {});
    const ai = await app.ai.active();
    if (!ai) throw new HttpError(409, "AI is off. Turn it on in Settings › AI to get a summary.");
    const data = await reportData(db, q.from, q.to);
    if (!data.spending.length && !data.income.length) throw badRequest("There's nothing in this period to summarize yet");

    const sumBy = <T>(rows: T[], keyOf: (r: T) => string, cents: (r: T) => number) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + cents(r));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const perMonth = data.months.map((m) => {
      const inc = data.income.filter((i) => i.year === m.year && i.month === m.month).reduce((t, i) => t + i.cents, 0);
      const out = data.spending.filter((s) => s.year === m.year && s.month === m.month).reduce((t, s) => t + s.cents, 0);
      return `${label(m)}: income ${dollars(inc)}, spent ${dollars(out)}`;
    });
    const groups = sumBy(data.spending, (s) => s.group, (s) => s.cents).map(([g, c]) => `${g} ${dollars(c)}`);
    const planned = sumBy(data.planned, (s) => s.group, (s) => s.cents);
    const spentBy = new Map(sumBy(data.spending, (s) => s.group, (s) => s.cents));
    const overPlan = planned.filter(([g, p]) => (spentBy.get(g) ?? 0) > p).map(([g, p]) => `${g} spent ${dollars(spentBy.get(g)!)} of ${dollars(p)} planned`);
    const unusual = unusualSpending(data).slice(0, 6).map((u) => `${u.item} (${u.group}) ${dollars(u.cents)} vs usual ${dollars(u.usualCents)}`);
    const merchants = data.merchants.slice(0, 5).map((m) => `${m.name} ${dollars(m.cents)} (${m.visits} visits)`);
    const user = [
      `Period: ${label(data.months[0])} to ${label(data.months[data.months.length - 1])}`,
      `By month:\n${perMonth.join("\n")}`,
      `Spending by group: ${groups.join(", ")}`,
      overPlan.length ? `Over plan: ${overPlan.join("; ")}` : "No group went over its plan.",
      unusual.length ? `Higher than usual in ${label(data.months[data.months.length - 1])}: ${unusual.join("; ")}` : "",
      merchants.length ? `Top merchants: ${merchants.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const r = await app.ai.chatWithFailover(ai.services, SUMMARY_SYSTEM, user, 400, ai.timeoutSec * 1000);
      return { text: r.text.trim(), service: r.service.name, model: r.service.model };
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(502, `The AI couldn't write a summary: ${e.message}`);
      throw e;
    }
  });
}
