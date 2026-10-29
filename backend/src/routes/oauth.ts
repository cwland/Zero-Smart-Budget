import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import * as client from "openid-client";
import { users } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { logEvent } from "../lib/appLog.js";
import { AUTH_MODES, encryptOAuthSecret, getOAuth, oauthReady, providerConfig, resetOAuthCache, saveOAuth, secretFor, type StoredOAuth } from "../lib/oauth.js";
import { logSignIn, startSession } from "../lib/sessions.js";
import { checkLockout, clearFailures, publicUser, recordFailure } from "./auth.js";

// OAuth / OpenID Connect sign-in (authorization code flow with PKCE, state and nonce):
//  1. POST /api/auth/oauth/start (or /link/start, signed in): the page gets the provider's URL
//  2. the provider sends the browser back to GET /api/auth/oauth/callback
//  3. that redirects to the app with a one-time ticket (never the session token itself),
//     which the page swaps for a session at POST /api/auth/oauth/finish
// The redirect URI to register at the provider: {app address}/api/auth/oauth/callback

const FLOW_MS = 10 * 60 * 1000;
const TICKET_MS = 60 * 1000;
type Flow = { purpose: "login" | "link"; userId?: number; verifier: string; nonce: string; redirectUri: string; appOrigin: string; ip: string; userAgent: string | null; expires: number };
const flows = new Map<string, Flow>();
const tickets = new Map<string, { token: string; user: ReturnType<typeof publicUser>; expires: number }>();
export function resetOAuthFlows() {
  flows.clear();
  tickets.clear();
}
const sweep = () => {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expires < now) flows.delete(k);
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
};

// The address the browser is on (the page calls /start with fetch, so Origin is set)
function appOrigin(req: FastifyRequest) {
  const o = req.headers.origin;
  if (typeof o !== "string" || !o) throw new HttpError(400, "Start OAuth sign-in from the app in a browser.");
  try {
    return new URL(o).origin;
  } catch {
    throw new HttpError(400, "Start OAuth sign-in from the app in a browser.");
  }
}
const callbackUri = (origin: string) => `${origin}/api/auth/oauth/callback`;

// Settings as the Settings page sees them (the secret only as "saved or not")
const view = (s: StoredOAuth, jwtSecret: string) => {
  const { clientSecretEnc, ...rest } = s;
  const secret = secretFor(s, jwtSecret);
  return { ...rest, clientSecretSet: !!clientSecretEnc, clientSecretUnreadable: !!clientSecretEnc && secret === null, ready: oauthReady(s) };
};

const url = z.string().trim().url("Enter a full address, starting with https://").max(500).nullable().optional().or(z.literal("").transform(() => null));

export default async function oauthRoutes(app: FastifyInstance) {
  const { db } = app;
  const fetchImpl = app.oauthFetch; // tests use a fake provider
  const requireLogin = (req: FastifyRequest) => {
    if (req.auth?.method !== "token") throw new HttpError(403, "Sign in to do this");
    return req.auth.userId;
  };

  // ---------- Settings > Security (OAuth sign-in) ----------

  app.get("/api/settings/oauth", async (req) => {
    const userId = requireLogin(req);
    const s = await getOAuth(db);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    return { settings: view(s, app.jwtSecret), linked: u?.oauthSubject ? { issuer: u.oauthIssuer, email: u.oauthEmail } : null };
  });

  app.put("/api/settings/oauth", async (req) => {
    const userId = requireLogin(req);
    const body = z
      .object({
        enabled: z.boolean(),
        providerName: z.string().trim().min(1, "Give the button a name, like Authentik").max(40),
        clientId: z.string().trim().max(300),
        clientSecret: z.string().max(1000).optional(), // left out: keep the saved one; "": remove it
        discoveryUrl: url,
        authorizeUrl: url,
        tokenUrl: url,
        userinfoUrl: url,
        scopes: z.string().trim().max(300).default("openid email profile"),
        authMode: z.enum(AUTH_MODES),
      })
      .parse(req.body);
    const current = await getOAuth(db);
    const next: StoredOAuth = {
      enabled: body.enabled,
      providerName: body.providerName,
      clientId: body.clientId,
      clientSecretEnc: body.clientSecret === undefined ? current.clientSecretEnc : body.clientSecret ? encryptOAuthSecret(body.clientSecret, app.jwtSecret) : null,
      discoveryUrl: body.discoveryUrl ?? null,
      authorizeUrl: body.authorizeUrl ?? null,
      tokenUrl: body.tokenUrl ?? null,
      userinfoUrl: body.userinfoUrl ?? null,
      scopes: body.scopes || "openid email profile",
      authMode: body.authMode,
    };
    if (next.enabled && !next.clientId) throw new HttpError(400, "Enter the Client ID");
    if (next.enabled && !next.discoveryUrl && !(next.authorizeUrl && next.tokenUrl && next.userinfoUrl))
      throw new HttpError(400, "Enter the provider's discovery URL (or the authorize, token and user info URLs)");
    // Lockout prevention: OAuth only needs OAuth on, and this account linked (which proves it works)
    if (next.authMode === "OAUTH_ONLY") {
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!next.enabled) throw new HttpError(400, "Turn OAuth on before choosing OAuth only.");
      if (!u?.oauthSubject) throw new HttpError(400, "Link your account first (Link my account): that signs in with the provider once, so you know it works before passwords are turned off.");
    }
    await saveOAuth(db, next);
    return { settings: view(next, app.jwtSecret) };
  });

  // Reach the provider with the saved settings (discovery, or the URLs answer)
  app.post("/api/settings/oauth/test", async (req) => {
    requireLogin(req);
    const s = await getOAuth(db);
    if (!s.clientId || (!s.discoveryUrl && !s.authorizeUrl)) throw new HttpError(400, "Save the provider's details first.");
    resetOAuthCache();
    try {
      const config = await providerConfig(s, app.jwtSecret, fetchImpl);
      const m = config.serverMetadata();
      return { ok: true, issuer: m.issuer, authorize: m.authorization_endpoint, message: `Reached ${m.issuer}. Next, use Link my account to sign in with it once.` };
    } catch (e) {
      throw new HttpError(400, `Couldn't reach the provider: ${(e as Error).message}`);
    }
  });

  app.post("/api/auth/oauth/unlink", async (req) => {
    const userId = requireLogin(req);
    const s = await getOAuth(db);
    if (s.authMode === "OAUTH_ONLY" && oauthReady(s)) throw new HttpError(400, "Switch to Passwords & OAuth before unlinking, or you could be locked out.");
    await db.update(users).set({ oauthIssuer: null, oauthSubject: null, oauthEmail: null }).where(eq(users.id, userId));
    return { ok: true };
  });

  // ---------- the flow ----------

  async function begin(req: FastifyRequest, purpose: Flow["purpose"], userId?: number) {
    const s = await getOAuth(db);
    if (!oauthReady(s)) throw new HttpError(400, "OAuth sign-in isn't set up.");
    const origin = appOrigin(req);
    sweep();
    let config;
    try {
      config = await providerConfig(s, app.jwtSecret, fetchImpl);
    } catch (e) {
      await logEvent(db, { category: "api", level: "error", source: s.providerName, event: `Couldn't reach ${s.providerName} to sign in`, detail: (e as Error).message });
      throw new HttpError(502, `Couldn't reach ${s.providerName}. Try again, or sign in another way.`);
    }
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const redirectUri = callbackUri(origin);
    const oidc = s.scopes.split(/\s+/).includes("openid");
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: s.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      ...(oidc ? { nonce } : {}),
      ...(purpose === "link" ? { prompt: "login" } : {}),
    });
    flows.set(state, { purpose, userId, verifier, nonce: oidc ? nonce : "", redirectUri, appOrigin: origin, ip: req.ip, userAgent: req.headers["user-agent"] ?? null, expires: Date.now() + FLOW_MS });
    return { url: authUrl.href };
  }

  app.post("/api/auth/oauth/start", async (req) => {
    checkLockout(req);
    return begin(req, "login");
  });
  app.post("/api/auth/oauth/link/start", async (req) => begin(req, "link", requireLogin(req)));

  // Where the provider sends the browser back. Always ends with a redirect into the app.
  app.get("/api/auth/oauth/callback", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const flow = q.state ? flows.get(q.state) : undefined;
    if (q.state) flows.delete(q.state);
    const back = (origin: string, path: string, params: Record<string, string>) => reply.redirect(`${origin}/#${path}?${new URLSearchParams(params)}`);
    if (!flow || flow.expires < Date.now()) return reply.redirect(`/#/?${new URLSearchParams({ oauth_error: "That sign-in took too long or was already used. Try again." })}`);
    const fail = async (message: string, logReason: string) => {
      if (flow.purpose === "login") {
        recordFailure(req);
        await logSignIn(db, req, { username: null, success: false, reason: logReason });
        return back(flow.appOrigin, "/", { oauth_error: message });
      }
      return back(flow.appOrigin, "/settings/security", { oauth_error: message });
    };
    if (q.error) return fail(q.error_description || q.error, `OAuth: ${q.error}`);

    const s = await getOAuth(db);
    let claims: { sub: string; email?: string; email_verified?: boolean; iss?: string };
    try {
      const config = await providerConfig(s, app.jwtSecret, fetchImpl);
      const current = new URL(flow.redirectUri);
      for (const [k, v] of Object.entries(q)) if (typeof v === "string") current.searchParams.set(k, v);
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: q.state,
        ...(flow.nonce ? { expectedNonce: flow.nonce, idTokenExpected: true } : {}),
      });
      const idClaims = flow.nonce ? tokens.claims() : undefined;
      const info = await client.fetchUserInfo(config, tokens.access_token, idClaims?.sub ?? client.skipSubjectCheck).catch((e) => {
        if (idClaims) return {} as Record<string, unknown>; // the ID token is enough
        throw e;
      });
      const sub = String(idClaims?.sub ?? info.sub ?? "");
      if (!sub) throw new Error("The provider didn't say who you are (no subject).");
      claims = {
        sub,
        iss: String(idClaims?.iss ?? config.serverMetadata().issuer),
        email: (info.email ?? idClaims?.email) as string | undefined,
        email_verified: (info.email_verified ?? idClaims?.email_verified) as boolean | undefined,
      };
    } catch (e) {
      await logEvent(db, { category: "api", level: "error", source: s.providerName, event: `${s.providerName} sign-in failed`, detail: (e as Error).message });
      return fail(`${s.providerName} sign-in didn't work: ${(e as Error).message}`, `OAuth failed: ${(e as Error).message.slice(0, 100)}`);
    }

    if (flow.purpose === "link") {
      const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.oauthIssuer, claims.iss!), eq(users.oauthSubject, claims.sub)));
      if (taken && taken.id !== flow.userId) return fail("That identity is linked to another account.", "");
      await db.update(users).set({ oauthIssuer: claims.iss!, oauthSubject: claims.sub, oauthEmail: claims.email ?? null }).where(eq(users.id, flow.userId!));
      return back(flow.appOrigin, "/settings/security", { oauth: "linked" });
    }

    // Sign in: the linked identity, or the same verified email (which then links it)
    let [user] = await db.select().from(users).where(and(eq(users.oauthIssuer, claims.iss!), eq(users.oauthSubject, claims.sub)));
    if (!user && claims.email && claims.email_verified === true) {
      [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${claims.email.toLowerCase()}`);
      if (user && user.oauthSubject && (user.oauthSubject !== claims.sub || user.oauthIssuer !== claims.iss)) user = undefined as never; // already linked to someone else there
      if (user) [user] = await db.update(users).set({ oauthIssuer: claims.iss!, oauthSubject: claims.sub, oauthEmail: claims.email }).where(eq(users.id, user.id)).returning();
    }
    if (!user) {
      return fail(
        `This ${s.providerName} account isn't linked to Zero Smart Budget. Sign in another way, then use Settings › Security › Link my account.`,
        `OAuth: no matching account (${claims.email ?? claims.sub})`
      );
    }
    clearFailures(req);
    const { token, session } = await startSession(db, app.jwtSecret, req, user, s.providerName, app.now()); // "Authentik" in Signed-in devices
    await logSignIn(db, req, { username: user.username, success: true, reason: `Signed in with ${s.providerName}`, sessionId: session.id });
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, { token, user: publicUser(user), expires: Date.now() + TICKET_MS });
    return back(flow.appOrigin, "/oauth", { ticket });
  });

  // The page swaps the one-time ticket for the session
  app.post("/api/auth/oauth/finish", async (req) => {
    const { ticket } = z.object({ ticket: z.string() }).parse(req.body);
    sweep();
    const t = tickets.get(ticket);
    tickets.delete(ticket);
    if (!t) throw new HttpError(400, "That sign-in expired. Try again.");
    return { token: t.token, user: t.user };
  });
}

