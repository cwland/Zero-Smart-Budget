import { SignJWT, exportJWK, generateKeyPair } from "jose";

// A pretend OpenID Connect provider (like Authentik) for tests: discovery, JWKS, token, userinfo.
export async function fakeIdp(issuer = "https://idp.test/application/o/zsb") {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; sub: string; email?: string; verified?: boolean; redirectUri: string; challenge: string }>();
  const state = { clientId: "zsb-client", clientSecret: "zsb-secret", tokenCalls: 0, down: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (state.down) throw new TypeError("fetch failed");
    if (url.pathname.endsWith("/.well-known/openid-configuration"))
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.pathname.endsWith("/token")) {
      state.tokenCalls++;
      const form = new URLSearchParams(String(init?.body ?? ""));
      const c = codes.get(form.get("code") ?? "");
      if (!c || form.get("client_id") !== state.clientId || form.get("client_secret") !== state.clientSecret || form.get("redirect_uri") !== c.redirectUri || !form.get("code_verifier"))
        return json({ error: "invalid_grant" }, 400);
      codes.delete(form.get("code")!);
      const idToken = await new SignJWT({ nonce: c.nonce, email: c.email, email_verified: c.verified })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(state.clientId)
        .setSubject(c.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json({ access_token: `at-${c.sub}`, token_type: "Bearer", id_token: idToken, expires_in: 300 });
    }
    if (url.pathname.endsWith("/userinfo")) return json({});
    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  return {
    issuer,
    state,
    fetchImpl,
    // The user signs in at the provider: returns where the provider sends the browser back to
    approve(authorizeUrl: string, who: { sub: string; email?: string; verified?: boolean }) {
      const u = new URL(authorizeUrl);
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { nonce: u.searchParams.get("nonce") ?? "", redirectUri: u.searchParams.get("redirect_uri")!, challenge: u.searchParams.get("code_challenge")!, ...who });
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state")!);
      return back;
    },
  };
}
