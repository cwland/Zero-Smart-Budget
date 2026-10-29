import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { HttpError } from "./errors.js";

// Plaid bank connections. Keys are entered in Settings > Plaid and saved in app_settings
// under "plaid", with both secrets encrypted.
//  - sandbox:    fake banks and test data (free, unlimited)
//  - production: real banks (free Trial plan: up to 10 connections)

export type PlaidEnv = "sandbox" | "production";

export const PLAID_HOSTS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface StoredPlaid {
  clientId: string;
  env: PlaidEnv; // which secret/host is in use
  sandboxSecretEnc: string | null;
  productionSecretEnc: string | null;
}

export interface PlaidKeys {
  clientId: string;
  secret: string;
  env: PlaidEnv;
}

// Tests swap in a fake
export type PlaidFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

// An error Plaid sent back, e.g. INVALID_API_KEYS or ITEM_LOGIN_REQUIRED
export class PlaidError extends Error {
  constructor(
    public code: string,
    public type: string,
    message: string
  ) {
    super(message);
  }
}

export class PlaidService {
  constructor(
    private db: Db,
    private secret: string,
    private fetchImpl: PlaidFetch = fetch as unknown as PlaidFetch
  ) {}

  async stored(): Promise<StoredPlaid | null> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "plaid"));
    return (row?.value as StoredPlaid) ?? null;
  }

  private decrypt(enc: string | null) {
    if (!enc) return { value: null, unreadable: false };
    const value = decryptSecret(enc, this.secret);
    return { value, unreadable: value === null };
  }

  // Secrets: undefined = keep the saved one, "" or null = remove it
  async save(input: { clientId: string; env: PlaidEnv; sandboxSecret?: string | null; productionSecret?: string | null }) {
    const current = await this.stored();
    const next = (given: string | null | undefined, saved: string | null | undefined) =>
      given === undefined ? saved ?? null : given ? encryptSecret(given, this.secret) : null;
    const value: StoredPlaid = {
      clientId: input.clientId,
      env: input.env,
      sandboxSecretEnc: next(input.sandboxSecret, current?.sandboxSecretEnc),
      productionSecretEnc: next(input.productionSecret, current?.productionSecretEnc),
    };
    await this.db
      .insert(appSettings)
      .values({ key: "plaid", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    return value;
  }

  async clear() {
    await this.db.delete(appSettings).where(eq(appSettings.key, "plaid"));
  }

  // What the Settings page shows. The secrets are included (decrypted) so they can be revealed
  // with the eye button; only the signed-in Settings page asks for them, never API keys.
  async summary() {
    const s = await this.stored();
    if (!s) return null;
    const sandbox = this.decrypt(s.sandboxSecretEnc);
    const production = this.decrypt(s.productionSecretEnc);
    return {
      clientId: s.clientId,
      env: s.env,
      sandboxSecretSet: !!s.sandboxSecretEnc,
      productionSecretSet: !!s.productionSecretEnc,
      sandboxSecret: sandbox.value,
      productionSecret: production.value,
      unreadable: sandbox.unreadable || production.unreadable, // JWT_SECRET changed: re-enter
    };
  }

  // The saved secret for an environment (null if none or unreadable)
  async savedSecret(env: PlaidEnv) {
    const s = await this.stored();
    return this.decrypt((env === "production" ? s?.productionSecretEnc : s?.sandboxSecretEnc) ?? null).value;
  }

  // Keys for a specific environment (a bank connected in Sandbox keeps using Sandbox keys)
  async keysFor(env: PlaidEnv): Promise<PlaidKeys> {
    const s = await this.stored();
    const secret = await this.savedSecret(env);
    if (!s?.clientId || !secret) {
      throw new HttpError(400, `This bank was connected with your ${env === "production" ? "Production" : "Sandbox"} keys. Add that secret in Settings > Plaid.`);
    }
    return { clientId: s.clientId, secret, env };
  }

  encryptToken(token: string) {
    return encryptSecret(token, this.secret);
  }
  decryptToken(enc: string) {
    const t = decryptSecret(enc, this.secret);
    if (!t) throw new HttpError(500, "Can't read this bank's saved access (the server's JWT_SECRET changed). Remove it and connect again.");
    return t;
  }

  // Keys for the chosen environment, or null if not set up
  async keys(): Promise<PlaidKeys | null> {
    const s = await this.stored();
    if (!s?.clientId) return null;
    const { value } = this.decrypt(s.env === "production" ? s.productionSecretEnc : s.sandboxSecretEnc);
    return value ? { clientId: s.clientId, secret: value, env: s.env } : null;
  }

  // Call a Plaid endpoint. Keys go in the body, as Plaid expects.
  async call<T>(path: string, body: Record<string, unknown>, keys?: PlaidKeys): Promise<T> {
    const k = keys ?? (await this.keys());
    if (!k) throw new HttpError(400, "Plaid isn't set up yet. Add your keys in Settings > Plaid.");
    let res;
    try {
      res = await this.fetchImpl(PLAID_HOSTS[k.env] + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: k.clientId, secret: k.secret, ...body }),
      });
    } catch {
      throw new HttpError(502, "Couldn't reach Plaid. Check this computer's internet connection.");
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(json.error_code ?? "UNKNOWN");
      const msg = String(json.display_message ?? json.error_message ?? `Plaid returned ${res.status}`);
      throw new PlaidError(code, String(json.error_type ?? ""), msg);
    }
    return json as T;
  }

  // Checks keys by asking Plaid for a Link token (the same call "Connect a bank" will use)
  async test(keys?: PlaidKeys) {
    await this.call(
      "/link/token/create",
      {
        client_name: "Zero Smart Budget",
        user: { client_user_id: "cory" },
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
      },
      keys
    );
  }
}

// Friendlier wording for the errors people hit while setting up
export function explainPlaidError(e: PlaidError) {
  if (e.code === "INVALID_API_KEYS") return "Plaid didn't accept those keys. Check the client_id and that the secret is for the environment you picked.";
  if (e.code === "INVALID_FIELD" || e.code === "INVALID_REQUEST") return `Plaid rejected the request: ${e.message}`;
  return `${e.message} (${e.code})`;
}
