import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

function requireLogin(req: FastifyRequest): number {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
  return req.auth.userId;
}

export default async function profileRoutes(app: FastifyInstance) {
  const { db } = app;

  // Update username, display name and email (empty string clears display name / email)
  app.patch("/api/profile", async (req) => {
    const userId = requireLogin(req);
    const body = z
      .object({
        username: z.string().trim().min(1).max(100).optional(),
        displayName: z.string().trim().max(100).nullable().optional(),
        email: z.union([z.string().trim().email("That doesn't look like an email address").max(200), z.literal("")]).nullable().optional(),
      })
      .parse(req.body);

    if (body.username) {
      const [taken] = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.username}) = ${body.username.toLowerCase()}`, ne(users.id, userId)));
      if (taken) throw new HttpError(409, "That username is taken");
    }
    const [user] = await db
      .update(users)
      .set({
        username: body.username,
        displayName: body.displayName === undefined ? undefined : body.displayName || null,
        email: body.email === undefined ? undefined : body.email || null,
      })
      .where(eq(users.id, userId))
      .returning();
    return { id: user.id, username: user.username, displayName: user.displayName, email: user.email, seenVersion: user.seenVersion };
  });
}
