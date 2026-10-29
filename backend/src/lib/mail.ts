import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { logEvent } from "./appLog.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

// starttls: plain connection upgraded to TLS (required) - usually port 587
// ssl:      TLS from the start - usually port 465
// auto:     use TLS if the server offers it
// none:     never use TLS (local relays only)
export type EmailSecurity = "starttls" | "ssl" | "auto" | "none";

export interface EmailConfig {
  host: string;
  port: number;
  security: EmailSecurity;
  username: string | null;
  password: string | null;
  fromName: string | null;
  fromAddress: string;
  appUrl: string | null; // public address of the app, used in emailed links
}

// What's saved in app_settings under "email" (password encrypted)
export interface StoredEmail extends Omit<EmailConfig, "password"> {
  enabled: boolean;
  passwordEnc: string | null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Transport {
  sendMail(msg: MailMessage & { from: string }): Promise<unknown>;
  verify?(): Promise<unknown>;
}
export type TransportFactory = (config: EmailConfig) => Transport;

export const smtpTransport: TransportFactory = (c) =>
  nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === "ssl",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    auth: c.username ? { user: c.username, pass: c.password ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });

// Older setups put email in .env; still honored when nothing is saved in the app
export function emailConfigFromEnv(env: NodeJS.ProcessEnv): EmailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465;
  return {
    host,
    port,
    security: secure ? "ssl" : "auto",
    username: env.SMTP_USER || null,
    password: env.SMTP_PASS || null,
    fromName: null,
    fromAddress: from,
    appUrl: env.APP_URL ? env.APP_URL.replace(/\/+$/, "") : null,
  };
}

export const fromHeader = (c: EmailConfig) =>
  c.fromName ? `"${c.fromName.replace(/["\\\\]/g, "")}" <${c.fromAddress}>` : c.fromAddress;

export type EmailKind = "test" | "notification-test" | "password-reset" | "month-close" | "nudge" | "summary" | "other";
const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
  test: "Test email",
  "notification-test": "Notification test",
  "password-reset": "Password reset",
  "month-close": "Wrap-Up reminder",
  nudge: "Come-back nudge",
  summary: "Monthly summary",
  other: "Email",
};

export class MailService {
  constructor(
    private db: Db,
    private secret: string,
    private envConfig: EmailConfig | null,
    private transport: TransportFactory = smtpTransport
  ) {}

  get envAvailable() {
    return this.envConfig !== null;
  }
  get envHost() {
    return this.envConfig ? `${this.envConfig.host}:${this.envConfig.port}` : null;
  }

  async stored(): Promise<StoredEmail | null> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "email"));
    return (row?.value as StoredEmail) ?? null;
  }

  // Saved password, or null. unreadable = saved but can't be decrypted (JWT_SECRET changed)
  async storedPassword(): Promise<{ password: string | null; unreadable: boolean }> {
    const s = await this.stored();
    if (!s?.passwordEnc) return { password: null, unreadable: false };
    const password = decryptSecret(s.passwordEnc, this.secret);
    return { password, unreadable: password === null };
  }

  async save(settings: Omit<StoredEmail, "passwordEnc">, password: string | null | undefined) {
    const current = await this.stored();
    // undefined = keep the saved password; "" or null = remove it
    const passwordEnc = password === undefined ? current?.passwordEnc ?? null : password ? encryptSecret(password, this.secret) : null;
    const value: StoredEmail = { ...settings, passwordEnc };
    await this.db
      .insert(appSettings)
      .values({ key: "email", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async clear() {
    await this.db.delete(appSettings).where(eq(appSettings.key, "email"));
  }

  // The config in use: saved in the app (if any), otherwise .env
  async active(): Promise<{ config: EmailConfig; source: "app" | "env" } | null> {
    const s = await this.stored();
    if (s) {
      if (!s.enabled) return null; // turned off in the app
      const { password } = await this.storedPassword();
      const { enabled: _e, passwordEnc: _p, ...rest } = s;
      return { config: { ...rest, password }, source: "app" };
    }
    return this.envConfig ? { config: this.envConfig, source: "env" } : null;
  }

  // Reset links need both a working sender and the app's public address
  async canSendLinks() {
    const a = await this.active();
    return !!a?.config.appUrl;
  }

  // Sends, and records it in the email log (kind says what it was; only the subject is kept)
  async send(msg: MailMessage, config?: EmailConfig, kind: EmailKind = "other") {
    const c = config ?? (await this.active())?.config;
    if (!c) throw new Error("Email isn't set up");
    try {
      await this.transport(c).sendMail({ from: fromHeader(c), ...msg });
      await this.log(kind, msg, true);
    } catch (err) {
      await this.log(kind, msg, false, (err as Error).message);
      throw err;
    }
  }

  private async log(kind: EmailKind, msg: MailMessage, success: boolean, error?: string) {
    await logEvent(this.db, {
      category: "email",
      level: success ? "info" : "error",
      source: EMAIL_KIND_LABELS[kind],
      event: success ? `Sent "${msg.subject}" to ${msg.to}` : `Couldn't send "${msg.subject}" to ${msg.to}`,
      detail: error ?? null,
    });
  }

  // Connect and log in without sending (gives clear errors for wrong host/password)
  async verify(config: EmailConfig) {
    const t = this.transport(config);
    if (t.verify) await t.verify();
  }
}
