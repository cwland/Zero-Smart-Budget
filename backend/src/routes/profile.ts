import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { publicUser } from "./auth.js";

function requireLogin(req: FastifyRequest): number {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
  return req.auth.userId;
}

export default async function profileRoutes(app: FastifyInstance) {
  const { db } = app;

  // Update username, display name and email (empty string clears the display name; the email is
  // required: password reset links and notifications go there)
  app.patch("/api/profile", async (req) => {
    const userId = requireLogin(req);
    const body = z
      .object({
        username: z.string().trim().min(1).max(100).optional(),
        displayName: z.string().trim().max(100).nullable().optional(),
        email: z
          .string({ error: "Your email address is required (for password resets and notifications)" })
          .trim()
          .min(1, "Your email address is required (for password resets and notifications)")
          .email("That doesn't look like an email address")
          .max(200)
          .optional(),
        // Settings > Profile > Theme (the list is in frontend/src/themes.ts)
        theme: z.enum(["harbor", "midnight-coral", "plum-amber", "terracotta-sage", "slate-rose"]).optional(),
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
        email: body.email,
        theme: body.theme,
      })
      .where(eq(users.id, userId))
      .returning();
    // The whole signed-in user (role included), so the app doesn't lose Shared access after a save
    return publicUser(user);
  });
}
