import { versionLabel } from "../version";
import lockupSvg from "../assets/lockup.svg?raw"; // our own file (public/brand has the fixed-color versions)
import WhatsNew from "./WhatsNew";
import { KeyRound, LogIn } from "lucide-react";
import { passkeyError, passkeysAvailable, signInWithPasskey, startPasskeyAutofill } from "../passkeys";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import type { User } from "../session";

interface Props {
  mode: "setup" | "login";
  resetAvailable?: boolean;
  oauth?: { label: string } | null; // "Sign in with {label}"
  passwords?: boolean; // false: OAuth only (no password form)
  initialError?: string; // e.g. back from the OAuth provider without signing in
  onDone: (token: string, user: User) => void;
}

const input =
  "mt-1 w-full rounded border border-muted/60 bg-white px-3 py-2.5 text-base outline-none focus:border-action focus:ring-2 focus:ring-action/20";

export const TAGLINE = "AI-Powered Zero-Based Budgeting";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  const [news, setNews] = useState(false);
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-page px-4 pb-10">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-[0_4px_12px_rgba(31,36,38,0.06)]">
        {/* Logo: icon + wordmark (Figtree, outlined to shapes), drawn inline so it takes the theme's colors */}
        <div className="mb-7 w-full [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: lockupSvg }} />
        {children}
      </div>
      <p className="absolute inset-x-0 bottom-4 text-center text-xs text-muted">
        <button type="button" onClick={() => setNews(true)} className="hover:text-link hover:underline" title="What's new in this version">
          Zero Smart Budget {versionLabel}
        </button>
      </p>
      {news && <WhatsNew all onClose={() => setNews(false)} />}
    </div>
  );
}

function ForgotPassword({ onBack, initialWho }: { onBack: () => void; initialWho: string }) {
  const [who, setWho] = useState(initialWho);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/auth/forgot", who.trim() ? { who: who.trim() } : {});
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Reset your password</h1>
      {sent ? (
        <p role="status" className="mt-3 rounded bg-success-subtle px-3 py-2 text-success">
          Check your email. If there's an address on the account, a reset link is on its way. It works for 1 hour.
        </p>
      ) : (
        <>
          <p className="mt-2 text-subtle">We'll email a reset link to the address on your account.</p>
          <label className="mt-4 block text-sm font-medium text-subtle">
            Your username or email
            <input value={who} onChange={(e) => setWho(e.target.value)} autoComplete="username" autoFocus className="mt-1 w-full rounded border border-muted/60 bg-white px-3 py-2.5 outline-none focus:border-action focus:ring-2 focus:ring-action/20" />
          </label>
          {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
          <button onClick={send} disabled={busy || !who.trim()} className="mt-5 w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
            {busy ? "Sending…" : "Email me a reset link"}
          </button>
        </>
      )}
      <button onClick={onBack} className="mt-4 w-full text-center text-sm font-semibold text-link hover:underline">
        Back to sign in
      </button>
    </div>
  );
}

export default function AuthScreen({ mode, resetAvailable, oauth = null, passwords = true, initialError, onDone }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const setup = mode === "setup";
  const canPasskey = !setup && passkeysAvailable();
  const showForm = setup || passwords;
  // Passkey autofill: offered as soon as the page opens (1Password and the browser show it)
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!canPasskey || !showForm) return; // autofill offers the passkey on the username box
    return startPasskeyAutofill(
      (res) => done.current(res.token, res.user),
      (msg) => setError(msg)
    );
  }, [canPasskey, showForm]);

  async function passkey() {
    setError("");
    setBusy(true);
    try {
      const res = await signInWithPasskey();
      onDone(res.token, res.user);
    } catch (err) {
      const msg = passkeyError(err);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // OAuth: get the provider's sign-in address and go there (it comes back to the app)
  async function signInWithOAuth() {
    setError("");
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("POST", "/api/auth/oauth/start", {});
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  const oauthButton = (primary: boolean) =>
    oauth && (
      <button
        type="button"
        onClick={signInWithOAuth}
        disabled={busy}
        className={`flex w-full items-center justify-center gap-2 rounded py-3 font-semibold disabled:opacity-60 ${primary ? "bg-primary text-white hover:bg-primary-pressed" : "border border-primary text-primary hover:bg-pressed"}`}
      >
        <LogIn className="size-5" aria-hidden />
        Sign in with {oauth.label}
      </button>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const res = await api<{ token: string; user: User }>("POST", setup ? "/api/auth/setup" : "/api/auth/login", setup ? { username, password, email: email.trim() } : { username, password });
      onDone(res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError && err.details?.length ? err.details.map((d) => d.message).join(". ") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return (
      <AuthFrame>
        <ForgotPassword initialWho={username} onBack={() => setForgot(false)} />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form data-password-form onSubmit={submit}>
        <h1 className="text-lg font-semibold">{setup ? "Create your account" : "Sign in"}</h1>
        {setup && <p className="mt-1 text-sm text-subtle">First time here. You'll be the owner. You can invite others later in Settings › Profile.</p>}

        {!showForm && (
          <>
            <p className="mt-1 text-sm text-subtle">Sign in with {oauth?.label ?? "your identity provider"}{canPasskey ? " or a passkey" : ""}.</p>
            {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
            <div className="mt-6">{oauthButton(true)}</div>
          </>
        )}
        {showForm && (
          <>
        <label className="mt-5 block text-sm font-medium text-subtle">
          Username
          <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete={canPasskey ? "username webauthn" : "username"} required />
        </label>
        {setup && (
          <label className="mt-4 block text-sm font-medium text-subtle">
            Email
            <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" required />
            <span className="mt-1 block text-xs font-normal">For password resets and reminders. You can change it later in Settings › Profile.</span>
          </label>
        )}
        <label className="mt-4 block text-sm font-medium text-subtle">
          Password
          <input
            className={input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 8 : undefined}
            required
          />
        </label>
        {setup && (
          <label className="mt-4 block text-sm font-medium text-subtle">
            Confirm password
            <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}

        {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

        <button type="submit" disabled={busy} className="mt-6 w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
          {busy ? "One moment…" : setup ? "Create account" : "Sign in"}
        </button>
          </>
        )}
        {showForm && !setup && oauth && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>
            {oauthButton(false)}
          </>
        )}
        {canPasskey && (
          <>
            <div className={`my-4 flex items-center gap-3 text-xs text-muted ${oauth && showForm ? "hidden" : ""}`}>
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>
            <button type="button" onClick={passkey} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded border border-primary py-3 font-semibold text-primary hover:bg-pressed disabled:opacity-60">
              <KeyRound className="size-5" aria-hidden />
              Sign in with a passkey
            </button>
          </>
        )}
        {!setup && resetAvailable && (
          <button type="button" onClick={() => setForgot(true)} className="mt-4 w-full text-center text-sm font-semibold text-link hover:underline">
            Forgot password?
          </button>
        )}
      </form>
    </AuthFrame>
  );
}
