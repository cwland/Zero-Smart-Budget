import { useState, type FormEvent } from "react";
import { api } from "../api";
import type { User } from "../session";
import { Logo } from "./Icons";

interface Props {
  mode: "setup" | "login";
  resetAvailable?: boolean;
  onDone: (token: string, user: User) => void;
}

const input =
  "mt-1 w-full rounded border border-muted/60 bg-white px-3 py-2.5 text-base outline-none focus:border-action focus:ring-2 focus:ring-action/20";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-[0_4px_12px_rgba(31,36,38,0.06)]">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-10" />
          <span className="text-2xl font-semibold">Cory's Dollar</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/auth/forgot", {});
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
          {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
          <button onClick={send} disabled={busy} className="mt-5 w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
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

export default function AuthScreen({ mode, resetAvailable, onDone }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const setup = mode === "setup";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const res = await api<{ token: string; user: User }>("POST", setup ? "/api/auth/setup" : "/api/auth/login", { username, password });
      onDone(res.token, res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return (
      <AuthFrame>
        <ForgotPassword onBack={() => setForgot(false)} />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1 className="text-lg font-semibold">{setup ? "Create your account" : "Sign in"}</h1>
        {setup && <p className="mt-1 text-sm text-subtle">First time here. This will be the only login for this app.</p>}

        <label className="mt-5 block text-sm font-medium text-subtle">
          Username
          <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </label>
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
        {!setup && resetAvailable && (
          <button type="button" onClick={() => setForgot(true)} className="mt-4 w-full text-center text-sm font-semibold text-link hover:underline">
            Forgot password?
          </button>
        )}
      </form>
    </AuthFrame>
  );
}
