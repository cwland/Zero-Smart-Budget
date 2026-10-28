import { useState, type FormEvent } from "react";
import { api } from "../api";
import type { User } from "../session";
import { AuthFrame } from "./AuthScreen";

interface Props {
  token: string;
  onDone: (token: string, user: User) => void;
  onCancel: () => void;
}

export default function ResetPasswordScreen({ token, onDone, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const res = await api<{ token: string; user: User }>("POST", "/api/auth/reset", { token, newPassword: password });
      onDone(res.token, res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded border border-muted/60 bg-white px-3 py-2.5 outline-none focus:border-action focus:ring-2 focus:ring-action/20";
  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-subtle">This signs out every other device.</p>
        <label className="mt-5 block text-sm font-medium text-subtle">
          New password
          <input type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
        </label>
        <label className="mt-4 block text-sm font-medium text-subtle">
          Confirm new password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} required />
        </label>
        {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
        <button type="submit" disabled={busy} className="mt-6 w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
          {busy ? "One moment…" : "Set password and sign in"}
        </button>
        <button type="button" onClick={onCancel} className="mt-4 w-full text-center text-sm font-semibold text-link hover:underline">
          Back to sign in
        </button>
      </form>
    </AuthFrame>
  );
}
