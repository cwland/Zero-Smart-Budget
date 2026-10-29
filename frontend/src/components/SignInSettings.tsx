import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { useUnsavedGuard } from "../unsavedGuard";
import { Toggle } from "./BudgetSettings";
import { Card, field, primaryButton, secondaryButton } from "./settingsUi";

// Settings > Security (OAuth sign-in): OAuth / OpenID Connect (Authentik, Keycloak, Google...) and how you sign in
type AuthMode = "PASSWORDS_AND_OAUTH" | "OAUTH_ONLY";
interface OAuthSettings {
  enabled: boolean;
  providerName: string;
  clientId: string;
  clientSecretSet: boolean;
  clientSecretUnreadable: boolean;
  discoveryUrl: string | null;
  authorizeUrl: string | null;
  tokenUrl: string | null;
  userinfoUrl: string | null;
  scopes: string;
  authMode: AuthMode;
  ready: boolean;
}
interface Loaded {
  settings: OAuthSettings;
  linked: { issuer: string; email: string | null } | null;
}
type Form = { enabled: boolean; providerName: string; clientId: string; clientSecret: string; discoveryUrl: string; authorizeUrl: string; tokenUrl: string; userinfoUrl: string; scopes: string };
const toForm = (s: OAuthSettings): Form => ({
  enabled: s.enabled,
  providerName: s.providerName,
  clientId: s.clientId,
  clientSecret: "",
  discoveryUrl: s.discoveryUrl ?? "",
  authorizeUrl: s.authorizeUrl ?? "",
  tokenUrl: s.tokenUrl ?? "",
  userinfoUrl: s.userinfoUrl ?? "",
  scopes: s.scopes,
});
const errorText = (e: unknown) => (e instanceof ApiError && e.details?.length ? e.details.map((d) => d.message).join(". ") : (e as Error).message);
type Msg = { ok: boolean; text: string } | null;

export default function SignInSettings() {
  const [data, setData] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [linkMsg, setLinkMsg] = useState<Msg>(null);
  const [modeMsg, setModeMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const redirectUri = `${window.location.origin}/api/auth/oauth/callback`;

  const load = async () => {
    const d = await api<Loaded>("GET", "/api/settings/oauth");
    setData(d);
    setForm(toForm(d.settings));
    setManual(!d.settings.discoveryUrl && !!d.settings.authorizeUrl);
  };
  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: errorText(e) }));
    // Back from "Link my account"
    const p = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    if (p.get("oauth") === "linked") setLinkMsg({ ok: true, text: "Linked. You can now sign in with it." });
    if (p.get("oauth_error")) setLinkMsg({ ok: false, text: p.get("oauth_error")! });
    if (p.toString()) history.replaceState(null, "", "#/settings/security");
  }, []);

  const saved = data?.settings;
  const dirty = !!form && !!saved && (JSON.stringify({ ...toForm(saved) }) !== JSON.stringify({ ...form, clientSecret: "" }) || !!form.clientSecret);
  useUnsavedGuard("oauth-settings", dirty, "sign-in settings");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const body = (f: Form, authMode: AuthMode) => ({
    enabled: f.enabled,
    providerName: f.providerName.trim(),
    clientId: f.clientId.trim(),
    ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}),
    discoveryUrl: manual ? "" : f.discoveryUrl.trim(),
    authorizeUrl: manual ? f.authorizeUrl.trim() : "",
    tokenUrl: manual ? f.tokenUrl.trim() : "",
    userinfoUrl: manual ? f.userinfoUrl.trim() : "",
    scopes: f.scopes.trim(),
    authMode,
  });

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!form || !saved) return;
    setMsg(null);
    setBusy("save");
    try {
      await api("PUT", "/api/settings/oauth", body(form, saved.authMode));
      await load();
      setMsg({ ok: true, text: form.enabled ? "Saved. Use Test to check the connection." : "Saved. OAuth sign-in is off." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy("");
    }
  }

  // The switch: with details already saved it takes effect right away; otherwise it opens the
  // form and Save turns OAuth on. Turning it off also brings passwords back (if OAuth only was on).
  async function toggle(on: boolean) {
    if (!form || !saved) return;
    setMsg(null);
    set("enabled", on);
    const complete = !!saved.clientId && (!!saved.discoveryUrl || (!!saved.authorizeUrl && !!saved.tokenUrl && !!saved.userinfoUrl));
    if (on && !complete) return setMsg({ ok: true, text: "Enter your provider's details, then Save." });
    setBusy("save");
    try {
      await api("PUT", "/api/settings/oauth", body({ ...toForm(saved), enabled: on }, on ? saved.authMode : "PASSWORDS_AND_OAUTH"));
      await load();
      setMsg({ ok: true, text: on ? "OAuth sign-in is on." : saved.authMode === "OAUTH_ONLY" ? "OAuth sign-in is off, and password sign-in is back on." : "OAuth sign-in is off." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
      set("enabled", !on);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setMsg(null);
    setBusy("test");
    try {
      const r = await api<{ message: string }>("POST", "/api/settings/oauth/test");
      setMsg({ ok: true, text: r.message });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy("");
    }
  }

  async function link() {
    setLinkMsg(null);
    setBusy("link");
    try {
      const { url } = await api<{ url: string }>("POST", "/api/auth/oauth/link/start", {});
      window.location.assign(url);
    } catch (err) {
      setLinkMsg({ ok: false, text: errorText(err) });
      setBusy("");
    }
  }

  async function unlink() {
    setLinkMsg(null);
    try {
      await api("POST", "/api/auth/oauth/unlink");
      await load();
      setLinkMsg({ ok: true, text: "Unlinked." });
    } catch (err) {
      setLinkMsg({ ok: false, text: errorText(err) });
    }
  }

  // The sign-in mode saves right away, with the settings as they're saved
  async function setMode(mode: AuthMode) {
    if (!saved) return;
    setModeMsg(null);
    setBusy("mode");
    try {
      await api("PUT", "/api/settings/oauth", body(toForm(saved), mode));
      await load();
      setModeMsg({ ok: true, text: mode === "OAUTH_ONLY" ? "Saved. The sign-in page now shows only the OAuth button (and passkeys)." : "Saved. Password sign-in is on." });
    } catch (err) {
      setModeMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy("");
    }
  }

  if (!data || !form || !saved) return msg ? <p className="text-error">{msg.text}</p> : null;
  const oauthOnlyAllowed = saved.ready && !!data.linked;

  return (
    <>
      <Card title="OAuth sign-in" description="Sign in through your own identity provider (Authentik, Keycloak, Google, Microsoft...) using OpenID Connect.">
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <span className="font-semibold">Sign in with OAuth</span>
            <Toggle label="Sign in with OAuth" checked={form.enabled} disabled={!!busy} onChange={(v) => void toggle(v)} />
          </div>
          {!form.enabled && msg && <p role={msg.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>{msg.text}</p>}

          {form.enabled && (
            <>

          <label className="text-sm font-medium text-subtle">
            Button label
            <input aria-label="Button label" value={form.providerName} maxLength={40} onChange={(e) => set("providerName", e.target.value)} className={field} placeholder="e.g. Authentik" />
            <span className="mt-1 block font-normal">The sign-in page shows "Sign in with {form.providerName.trim() || "…"}".</span>
          </label>

          <div className="rounded-lg bg-page p-3 text-sm">
            <span className="font-semibold">Redirect URI</span> <span className="text-subtle">(add this to the app at your provider)</span>
            <span className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{redirectUri}</code>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard?.writeText(redirectUri).catch(() => {});
                  setCopied(true);
                }}
                className="shrink-0 text-sm font-semibold text-link hover:underline"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </span>
            <span className="mt-1 block text-xs text-subtle">Use the address you open the app at. Opening it at another address too? Add that address's redirect URI as well.</span>
          </div>

          {!manual ? (
            <label className="text-sm font-medium text-subtle">
              Issuer / discovery URL
              <input aria-label="Discovery URL" value={form.discoveryUrl} onChange={(e) => set("discoveryUrl", e.target.value)} className={field} placeholder="https://auth.example.com/application/o/zero-smart-budget/" />
              <span className="mt-1 block font-normal">
                Authentik: <code className="font-mono text-xs">https://auth…/application/o/&lt;slug&gt;/</code> · Keycloak: <code className="font-mono text-xs">https://kc…/realms/&lt;realm&gt;</code> · Google: <code className="font-mono text-xs">https://accounts.google.com</code>
              </span>
            </label>
          ) : (
            <div className="grid gap-3">
              {(
                [
                  ["authorizeUrl", "Authorize URL"],
                  ["tokenUrl", "Token URL"],
                  ["userinfoUrl", "User info URL"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="text-sm font-medium text-subtle">
                  {label}
                  <input aria-label={label} value={form[k]} onChange={(e) => set(k, e.target.value)} className={field} placeholder="https://" />
                </label>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setManual((m) => !m)} className="self-start text-sm font-semibold text-link hover:underline">
            {manual ? "Use a discovery URL instead (recommended)" : "No discovery URL? Enter the endpoints instead"}
          </button>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-subtle">
              Client ID
              <input aria-label="Client ID" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} className={field} autoComplete="off" spellCheck={false} />
            </label>
            <label className="text-sm font-medium text-subtle">
              Client secret
              <span className="relative block">
                <input
                  aria-label="Client secret"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  style={showSecret ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
                  value={form.clientSecret}
                  placeholder={saved.clientSecretSet ? "Saved. Leave blank to keep it." : "From your provider"}
                  onChange={(e) => set("clientSecret", e.target.value)}
                  className={field + " pr-14"}
                />
                <button type="button" onClick={() => setShowSecret((v) => !v)} className="absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 px-1 text-xs font-semibold text-link">
                  {showSecret ? "Hide" : "Show"}
                </button>
              </span>
              {saved.clientSecretUnreadable && <span className="mt-1 block text-sm font-normal text-error">The saved secret can't be read (the server's secret changed). Enter it again.</span>}
            </label>
          </div>

          <label className="text-sm font-medium text-subtle">
            Scopes
            <input aria-label="Scopes" value={form.scopes} onChange={(e) => set("scopes", e.target.value)} className={field + " font-mono text-sm"} />
          </label>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button type="submit" disabled={!!busy || !dirty} className={primaryButton}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {dirty && <span className="text-sm text-subtle">Unsaved changes</span>}
            <button type="button" onClick={test} disabled={!!busy || dirty || !saved.clientId} className={secondaryButton + " ml-auto"}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
          </div>
          {msg && <p role={msg.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>{msg.text}</p>}
            </>
          )}
        </form>
      </Card>

      {form.enabled && (
        <>
      <Card title="Your account" description="Link your account to the identity you use at the provider. You'll sign in there once to prove it.">
        {data.linked ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">✓ Linked{data.linked.email ? ` as ${data.linked.email}` : ""}</span>
              <span className="block break-all text-sm text-subtle">{data.linked.issuer}</span>
            </span>
            <button type="button" onClick={unlink} className="text-sm font-semibold text-error hover:underline">
              Unlink
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-sm text-subtle">Not linked. (Signing in with OAuth also links it, if the provider's verified email matches your profile's email.)</span>
            <button type="button" onClick={link} disabled={!!busy || !saved.ready || dirty} className={primaryButton}>
              {busy === "link" ? "Opening…" : "Link my account"}
            </button>
          </div>
        )}
        {!saved.ready && !data.linked && <p className="mt-2 text-sm text-subtle">Turn OAuth on and save the provider's details first.</p>}
        {linkMsg && <p role={linkMsg.ok ? "status" : "alert"} className={`mt-3 rounded-lg px-3 py-2 text-sm ${linkMsg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>{linkMsg.text}</p>}
      </Card>

      <Card title="How you sign in">
        <fieldset className="flex flex-col gap-3" disabled={busy === "mode"}>
          <legend className="sr-only">Sign-in mode</legend>
          {(
            [
              ["PASSWORDS_AND_OAUTH", "Passwords & OAuth", "The sign-in page has the password form and the OAuth button (and passkeys)."],
              ["OAUTH_ONLY", "OAuth only", "No password form, and the server refuses password sign-in. The OAuth button and passkeys still work."],
            ] as const
          ).map(([id, label, text]) => {
            const off = id === "OAUTH_ONLY" && !oauthOnlyAllowed && saved.authMode !== "OAUTH_ONLY";
            return (
              <label key={id} className={`flex gap-3 rounded-lg border p-3 ${saved.authMode === id ? "border-action bg-action/5" : "border-line"} ${off ? "opacity-60" : "cursor-pointer"}`}>
                <input type="radio" name="auth-mode" checked={saved.authMode === id} disabled={off} onChange={() => void setMode(id)} className="mt-1" />
                <span>
                  <span className="block font-semibold">{label}</span>
                  <span className="block text-sm text-subtle">{text}</span>
                  {off && <span className="mt-1 block text-sm text-subtle">Turn OAuth on and link your account first, so you know it works.</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
        {modeMsg && <p role={modeMsg.ok ? "status" : "alert"} className={`mt-3 rounded-lg px-3 py-2 text-sm ${modeMsg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>{modeMsg.text}</p>}
        <details className="mt-4 rounded-lg bg-page p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Locked out? Turn password sign-in back on</summary>
          <p className="mt-2 text-subtle">If your provider is down or misconfigured, run this on the server. It switches back to Passwords &amp; OAuth and turns OAuth off:</p>
          <pre className="mt-2 overflow-x-auto rounded bg-ink p-3 font-mono text-xs leading-relaxed text-white">{`cd backend && npm run auth:reset

# with Docker
docker compose exec api npm run auth:reset

# or add to .env and restart
EMERGENCY_DISABLE_OAUTH=true`}</pre>
          <p className="mt-2 text-subtle">A passkey also gets you in while OAuth is the only option.</p>
        </details>
      </Card>
        </>
      )}
    </>
  );
}
