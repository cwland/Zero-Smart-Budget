import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { EmailConfig } from "../lib/mail.js";
import { getBudgetPrefs, saveBudgetPrefs } from "../lib/prefs.js";
import { PlaidError, explainPlaidError, type PlaidKeys } from "../lib/plaid.js";
import { AI_PROVIDERS, AiError, type AiConfig } from "../lib/ai.js";

function requireLogin(req: FastifyRequest): number {
  if (req.auth?.method !== "token") throw new HttpError(403, "Log in to do this");
  return req.auth.userId;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const emailSettings = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().max(253).default(""),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    security: z.enum(["starttls", "ssl", "auto", "none"]).default("starttls"),
    username: optionalText(320),
    password: z.string().max(500).nullable().optional(), // undefined = keep saved, "" = remove
    fromName: optionalText(100),
    fromAddress: z.string().trim().max(320).default(""),
    appUrl: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.fromAddress && !z.string().email().safeParse(v.fromAddress).success) {
      ctx.addIssue({ code: "custom", path: ["fromAddress"], message: "From address isn't a valid email" });
    }
    if (v.appUrl && !/^https?:\/\/[^\s/]+/.test(v.appUrl)) {
      ctx.addIssue({ code: "custom", path: ["appUrl"], message: "App address should start with http:// or https://" });
    }
    if (v.enabled) {
      if (!v.host) ctx.addIssue({ code: "custom", path: ["host"], message: "Server is required" });
      if (!v.fromAddress) ctx.addIssue({ code: "custom", path: ["fromAddress"], message: "From address is required" });
    }
  });

export default async function settingsRoutes(app: FastifyInstance) {
  const { db, mail } = app;

  const accountEmail = async (userId: number) =>
    (await db.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]?.email ?? null;

  // Current email settings. The password itself is never sent back.
  app.get("/api/settings/email", async (req) => {
    const userId = requireLogin(req);
    const stored = await mail.stored();
    const active = await mail.active();
    const { unreadable } = await mail.storedPassword();
    return {
      source: stored ? "app" : active?.source ?? "none", // where settings come from
      active: !!active,
      linksReady: !!active?.config.appUrl,
      settings: stored
        ? {
            enabled: stored.enabled,
            host: stored.host,
            port: stored.port,
            security: stored.security,
            username: stored.username,
            passwordSet: !!stored.passwordEnc,
            passwordUnreadable: unreadable,
            fromName: stored.fromName,
            fromAddress: stored.fromAddress,
            appUrl: stored.appUrl,
          }
        : null,
      env: { available: mail.envAvailable, host: mail.envHost },
      accountEmail: await accountEmail(userId),
    };
  });

  // ---------- Plaid keys ----------
  const plaidSettings = z.object({
    clientId: z.string().trim().min(1, "Client ID is required").max(100),
    env: z.enum(["sandbox", "production"]),
    sandboxSecret: z.string().trim().max(200).nullable().optional(), // undefined = keep saved, "" = remove
    productionSecret: z.string().trim().max(200).nullable().optional(),
  });

  app.get("/api/settings/plaid", async (req) => {
    requireLogin(req);
    return { settings: await app.plaid.summary() };
  });

  app.put("/api/settings/plaid", async (req) => {
    requireLogin(req);
    const body = plaidSettings.parse(req.body);
    await app.plaid.save(body);
    return { settings: await app.plaid.summary() };
  });

  app.delete("/api/settings/plaid", async (req, reply) => {
    requireLogin(req);
    await app.plaid.clear();
    return reply.status(204).send();
  });

  // Check keys with Plaid. With a body, tests those (unsaved) values; blank secret = the saved one.
  app.post("/api/settings/plaid/test", async (req) => {
    requireLogin(req);
    let keys: PlaidKeys | undefined;
    if (req.body && Object.keys(req.body as object).length) {
      const b = plaidSettings.parse(req.body);
      const given = b.env === "production" ? b.productionSecret : b.sandboxSecret;
      const secret = given || (await app.plaid.savedSecret(b.env));
      if (!secret) throw new HttpError(400, `Enter your ${b.env === "production" ? "Production" : "Sandbox"} secret first`);
      keys = { clientId: b.clientId, secret, env: b.env };
    }
    try {
      await app.plaid.test(keys);
    } catch (e) {
      if (e instanceof PlaidError) throw new HttpError(400, explainPlaidError(e));
      throw e;
    }
    const env = keys?.env ?? (await app.plaid.keys())?.env;
    return { ok: true, message: `Plaid accepted your ${env === "production" ? "Production" : "Sandbox"} keys.` };
  });

  // ---------- AI provider ----------
  const aiSettings = z
    .object({
      enabled: z.boolean(),
      provider: z.enum(AI_PROVIDERS),
      model: z.string().trim().max(200).default(""),
      baseUrl: optionalText(500),
      apiKey: z.string().trim().max(500).nullable().optional(), // undefined = keep saved, "" = remove
      mode: z.enum(["auto", "manual"]).default("auto"),
      maxPerRun: z.coerce.number().int().min(1).max(500).default(50),
    })
    .superRefine((v, ctx) => {
      if (v.baseUrl && !/^https?:\/\/[^\s/]+/.test(v.baseUrl)) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Address should start with http:// or https://" });
      if (v.enabled && v.provider === "local" && !v.baseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter your AI server's address" });
      if (v.enabled && !v.model) ctx.addIssue({ code: "custom", path: ["model"], message: "Choose a model" });
    });

  // The config to test or list models with: typed values, with a blank key falling back to the saved one
  const aiConfigFrom = async (body: unknown): Promise<AiConfig> => {
    const b = aiSettings.safeParse({ ...(body as object), enabled: false }); // testing/listing: the save-time checks (like "choose a model") don't apply
    if (!b.success) throw b.error;
    const v = b.data;
    const apiKey = v.apiKey === undefined || v.apiKey === null || v.apiKey === "" ? (await app.ai.savedKey()).key : v.apiKey;
    return { provider: v.provider, model: v.model, baseUrl: v.baseUrl, apiKey };
  };
  const aiErrors = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(400, e.message);
      throw e;
    }
  };

  app.get("/api/settings/ai", async (req) => {
    requireLogin(req);
    return { settings: await app.ai.summary() };
  });

  app.put("/api/settings/ai", async (req) => {
    requireLogin(req);
    const { apiKey, ...rest } = aiSettings.parse(req.body);
    await app.ai.save({ ...rest, baseUrl: rest.baseUrl ? rest.baseUrl.replace(/\/+$/, "") : null, apiKey: apiKey === null ? "" : apiKey });
    return { settings: await app.ai.summary() };
  });

  app.delete("/api/settings/ai", async (req, reply) => {
    requireLogin(req);
    await app.ai.clear();
    return reply.status(204).send();
  });

  app.post("/api/settings/ai/test", async (req) => {
    requireLogin(req);
    const c = await aiConfigFrom(req.body);
    await aiErrors(() => app.ai.test(c));
    return { ok: true, message: `${c.model} answered correctly.` };
  });

  app.post("/api/settings/ai/models", async (req) => {
    requireLogin(req);
    const c = await aiConfigFrom(req.body);
    return { models: await aiErrors(() => app.ai.models(c)) };
  });

  // Budget preferences (Fast Track)
  app.get("/api/settings/budget", async () => getBudgetPrefs(db));

  app.put("/api/settings/budget", async (req) => {
    requireLogin(req);
    const body = z.object({ fastTrack: z.boolean().optional(), tossAnimation: z.boolean().optional() }).strict().parse(req.body);
    return saveBudgetPrefs(db, body);
  });

  app.put("/api/settings/email", async (req) => {
    requireLogin(req);
    const { password, ...rest } = emailSettings.parse(req.body);
    await mail.save({ ...rest, appUrl: rest.appUrl ? rest.appUrl.replace(/\/+$/, "") : null }, password === null ? "" : password);
    return { ok: true };
  });

  // Forget the app's email settings (falls back to .env, if set there)
  app.delete("/api/settings/email", async (req, reply) => {
    requireLogin(req);
    await mail.clear();
    return reply.status(204).send();
  });

  // Send a test email. With `settings`, tests those (unsaved) values; otherwise the saved ones.
  app.post("/api/settings/email/test", async (req) => {
    const userId = requireLogin(req);
    const body = z
      .object({ settings: emailSettings.optional(), to: z.string().trim().email("Enter a valid address to send the test to").optional() })
      .parse(req.body ?? {});

    let config: EmailConfig;
    if (body.settings) {
      const { password, enabled: _enabled, ...s } = body.settings;
      if (!s.host || !s.fromAddress) throw new HttpError(400, "Fill in the server and from address first");
      // Blank password field = use the saved one
      const saved = password ? null : (await mail.storedPassword()).password;
      config = { ...s, password: password || saved };
    } else {
      const active = await mail.active();
      if (!active) throw new HttpError(400, "Email isn't set up yet");
      config = active.config;
    }

    const to = body.to ?? (await accountEmail(userId));
    if (!to) throw new HttpError(400, "Add an email address to your profile, or enter one to send the test to");

    try {
      await mail.verify(config);
      await mail.send(
        {
          to,
          subject: "Cory's Dollar test email",
          text: "Email from Cory's Dollar is working. Password reset links will arrive like this one.",
        },
        config
      );
    } catch (err) {
      req.log.warn(err);
      const msg = (err as Error).message.replace(/\s+/g, " ").slice(0, 300);
      throw new HttpError(502, `Couldn't send: ${msg}`);
    }
    return { ok: true, to };
  });
}
