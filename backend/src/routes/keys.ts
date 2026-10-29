import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import { generateApiKey } from "../lib/auth.js";
import { KEY_ACCESS } from "../lib/keyAccess.js";
import { HttpError, notFound } from "../lib/errors.js";
import { idParam, name } from "../lib/validation.js";

// Only a logged-in user (not another API key) can manage API keys
function requireLogin(req: FastifyRequest) {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to manage API keys");
}

export default async function keyRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get("/api/keys", async (req) => {
    requireLogin(req);
    return db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        access: apiKeys.access,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .orderBy(asc(apiKeys.id));
  });

  // The full key is returned once, here. It can't be shown again.
  app.post("/api/keys", async (req, reply) => {
    requireLogin(req);
    const body = z.object({ name, access: z.enum(KEY_ACCESS).default("read_add") }).parse(req.body);
    const { key, prefix, hash } = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ name: body.name, prefix, keyHash: hash, access: body.access })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, access: apiKeys.access });
    return reply.status(201).send({ ...row, key });
  });

  // Change what a key may do (the key itself stays the same)
  app.patch("/api/keys/:id", async (req) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ access: z.enum(KEY_ACCESS) }).parse(req.body);
    const [row] = await db
      .update(apiKeys)
      .set({ access: body.access })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id, name: apiKeys.name, access: apiKeys.access });
    if (!row) throw notFound("API key");
    return row;
  });

  app.delete("/api/keys/:id", async (req, reply) => {
    requireLogin(req);
    const { id } = idParam.parse(req.params);
    const deleted = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id });
    if (!deleted.length) throw notFound("API key");
    return reply.status(204).send();
  });
}
