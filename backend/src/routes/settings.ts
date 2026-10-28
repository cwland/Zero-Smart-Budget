import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import type { EmailConfig } from "../lib/mail.js";

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
