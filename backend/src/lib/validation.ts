import { z } from "zod";

// Money is always whole cents
export const cents = z.number().int().min(0).max(2_000_000_000);
export const positiveCents = z.number().int().min(1).max(2_000_000_000);
export const name = z.string().trim().min(1).max(200);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const idList = z.object({ ids: z.array(z.number().int().positive()) });
export const yearMonthParams = z.object({
  year: z.coerce.number().int().min(2000).max(2200),
  month: z.coerce.number().int().min(1).max(12),
});
