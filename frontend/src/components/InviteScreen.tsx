import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { User } from "../session";
import { AuthFrame } from "./AuthScreen";

const WHAT_YOU_CAN_DO = {
  admin: "You can see and do everything in the app, including its settings.",
  user: "You can use the budget, transactions, accounts and reports, and set up your own profile and notifications.",
};

// "#/invite?token=..." from a shared access invite: pick a username and password, then you're in

interface Props {
  token: string;
  onDone: (token: string, user: User) => void;
  onCancel: () => void;
}

export default function InviteScreen({ token, onDone, onCancel }: Props) {
  const [invite, setInvite] = useState<{ name: string | null; email: string; role: "admin" | "user"; from: string | null } | null>(null);
  const [bad, setBad] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<NonNullable<typeof invite>>("GET", `/api/auth/invite?token=${encodeURIComponent(token)}`)
      .then((i) => {
        setInvite(i);
        setEmail(i.email);
      })
      .catch((e) => setBad((e as Error).message));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const res = await api<{ token: string; user: User }>("POST", "/api/auth/invite/accept", { token, username: username.trim(), password, email: email.trim() });
      onDone(res.token, res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded border border-muted/60 bg-white px-3 py-2.5 outline-none focus:border-action focus:ring-2 focus:ring-action/20";
  const back = (
    <button type="button" onClick={onCancel} className="mt-4 w-full text-center text-sm font-semibold text-link hover:underline">
      Go to sign in
    </button>
  );

  if (bad) {
    return (
      <AuthFrame>
        <h1 className="text-lg font-semibold">This invite can't be used</h1>
        <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{bad}</p>
        {back}
      </AuthFrame>
    );
  }
  if (!invite) {
    return (
      <AuthFrame>
        <p className="text-subtle">Checking your invite…</p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form data-password-form onSubmit={submit}>
        <h1 className="text-lg font-semibold">{invite.name ? `Welcome, ${invite.name}` : "You're invited"}</h1>
        <p className="mt-1 text-sm text-subtle">
          {invite.from ? <strong>{invite.from}</strong> : "Someone"} shared their budget with you as {invite.role === "admin" ? "an" : "a"} <strong>{invite.role}</strong>. {WHAT_YOU_CAN_DO[invite.role]}
        </p>
        <label className="mt-5 block text-sm font-medium text-subtle">
          Username
          <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </label>
        <label className="mt-4 block text-sm font-medium text-subtle">
          Email
          <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <span className="mt-1 block text-xs font-normal">For password resets and your notifications.</span>
        </label>
        <label className="mt-4 block text-sm font-medium text-subtle">
          Password
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        <label className="mt-4 block text-sm font-medium text-subtle">
          Confirm password
          <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        {error && <p role="alert" className="mt-4 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
        <button type="submit" disabled={busy} className="mt-6 w-full rounded bg-primary py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60">
          {busy ? "One moment…" : "Create my sign-in"}
        </button>
        {back}
      </form>
    </AuthFrame>
  );
}
