import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiSummary, cashFlow, reportData, unusualSpending, ymIndex } from "../lib/reports.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { AiError } from "../lib/ai.js";

const ym = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM")
  .transform((v) => ({ year: Number(v.slice(0, 4)), month: Number(v.slice(5, 7)) }))
  .refine((v) => v.month >= 1 && v.month <= 12, "Not a real month");
const range = z.object({ from: ym, to: ym }).refine((r) => ymIndex(r.from) <= ymIndex(r.to), "The start month is after the end month").refine((r) => ymIndex(r.to) - ymIndex(r.from) <= 120, "Pick ten years or less");

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
    try {
      const r = await aiSummary(app.ai, ai.services, ai.timeoutSec, data);
      return { text: r.text, service: r.service, model: r.model };
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(502, `The AI couldn't write a summary: ${e.message}`);
      throw e;
    }
  });
}
