import { eq } from "drizzle-orm";
import * as client from "openid-client";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

// Sign in with OAuth 2 / OpenID Connect (Authentik, Keycloak, Google, Microsoft...).
// Settings live in app_settings under "oauth" (the client secret encrypted).
//  - PASSWORDS_AND_OAUTH: the password form and the OAuth button (passkeys too)
//  - OAUTH_ONLY: no password sign-in (the API refuses it too); OAuth and passkeys only
// Locked out? `npm run auth:reset`, or EMERGENCY_DISABLE_OAUTH=true, switches back.

export const AUTH_MODES = ["PASSWORDS_AND_OAUTH", "OAUTH_ONLY"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface StoredOAuth {
  enabled: boolean;
  providerName: string; // the button says "Sign in with {providerName}"
  clientId: string;
  clientSecretEnc: string | null;
  discoveryUrl: string | null; // issuer or .well-known/openid-configuration URL (OpenID Connect)
  // ...or, for plain OAuth 2 without discovery:
  authorizeUrl: string | null;
  tokenUrl: string | null;
  userinfoUrl: string | null;
  scopes: string;
  authMode: AuthMode;
}

export const OAUTH_DEFAULTS: StoredOAuth = {
  enabled: false,
  providerName: "OAuth",
  clientId: "",
  clientSecretEnc: null,
  discoveryUrl: null,
  authorizeUrl: null,
  tokenUrl: null,
  userinfoUrl: null,
  scopes: "openid email profile",
  authMode: "PASSWORDS_AND_OAUTH",
};

export async function getOAuth(db: Db): Promise<StoredOAuth> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "oauth"));
  return { ...OAUTH_DEFAULTS, ...((row?.value as Partial<StoredOAuth>) ?? {}) };
}

export async function saveOAuth(db: Db, value: StoredOAuth) {
  await db
    .insert(appSettings)
    .values({ key: "oauth", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  configCache = null;
}

export const secretFor = (s: StoredOAuth, jwtSecret: string) => (s.clientSecretEnc ? decryptSecret(s.clientSecretEnc, jwtSecret) : null);
export const encryptOAuthSecret = (plain: string, jwtSecret: string) => encryptSecret(plain, jwtSecret);

// Ready to use: on, with a client ID and either discovery or the endpoints
export const oauthReady = (s: StoredOAuth) => s.enabled && !!s.clientId && (!!s.discoveryUrl || (!!s.authorizeUrl && !!s.tokenUrl && !!s.userinfoUrl));
// Password sign-in is refused only when OAuth-only is chosen AND OAuth is actually on
export const passwordsAllowed = (s: StoredOAuth) => !(s.authMode === "OAUTH_ONLY" && oauthReady(s));

// The library's view of the provider (discovery is looked up once and kept for 10 minutes)
let configCache: { key: string; at: number; config: client.Configuration } | null = null;
export function resetOAuthCache() {
  configCache = null;
}

export async function providerConfig(s: StoredOAuth, jwtSecret: string, fetchImpl?: typeof fetch): Promise<client.Configuration> {
  const secret = secretFor(s, jwtSecret) ?? undefined;
  const key = JSON.stringify([s.discoveryUrl, s.authorizeUrl, s.tokenUrl, s.userinfoUrl, s.clientId, s.clientSecretEnc]);
  if (configCache && configCache.key === key && Date.now() - configCache.at < 10 * 60 * 1000) return configCache.config;
  const insecure = [s.discoveryUrl, s.authorizeUrl, s.tokenUrl].some((u) => u?.startsWith("http://"));
  let config: client.Configuration;
  if (s.discoveryUrl) {
    const url = new URL(s.discoveryUrl.replace(/\/\.well-known\/openid-configuration\/?$/, ""));
    config = await client.discovery(url, s.clientId, secret, undefined, {
      ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
      ...(fetchImpl ? { [client.customFetch]: fetchImpl as never } : {}),
    });
  } else {
    config = new client.Configuration(
      { issuer: new URL(s.authorizeUrl!).origin, authorization_endpoint: s.authorizeUrl!, token_endpoint: s.tokenUrl!, userinfo_endpoint: s.userinfoUrl! },
      s.clientId,
      secret
    );
    if (insecure) client.allowInsecureRequests(config);
  }
  if (fetchImpl) config[client.customFetch] = fetchImpl as never;
  configCache = { key, at: Date.now(), config };
  return config;
}

// Lockout prevention: back to passwords (and OAuth off unless keepOAuth)
export async function emergencyResetAuth(db: Db, keepOAuth = false) {
  const s = await getOAuth(db);
  const next: StoredOAuth = { ...s, authMode: "PASSWORDS_AND_OAUTH", enabled: keepOAuth ? s.enabled : false };
  await saveOAuth(db, next);
  return { was: { authMode: s.authMode, enabled: s.enabled }, now: { authMode: next.authMode, enabled: next.enabled } };
}
