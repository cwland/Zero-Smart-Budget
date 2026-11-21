import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { useSession, type User } from "../session";
import { Card, Notice, field, primaryButton } from "./settingsUi";

export default function ProfileSettings() {
  const { user, setUser } = useSession();
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const changed = username.trim() !== user.username || displayName.trim() !== (user.displayName ?? "") || email.trim() !== (user.email ?? "");

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const updated = await api<User>("PATCH", "/api/profile", { username: username.trim(), displayName: displayName.trim(), email: email.trim() });
      setUser(updated);
      setMsg({ ok: true, text: "Saved" });
    } catch (err) {
      setMsg({ ok: false, text: (err instanceof ApiError && err.details?.[0]?.message) || (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Your details">
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-subtle">
          Username <span className="font-normal text-muted">(for signing in)</span>
          <input aria-label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={field} required />
        </label>
        <label className="text-sm font-medium text-subtle">
          Display name <span className="font-normal text-muted">(optional)</span>
          <input aria-label="Display name" autoComplete="name" placeholder="e.g. Alex" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={field} />
        </label>
        <label className="text-sm font-medium text-subtle sm:col-span-2">
          Email <span className="font-normal text-muted">(required, for password resets and notifications)</span>
          <input aria-label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={field} required />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={busy || !changed} className={primaryButton}>
            Save
          </button>
          <Notice msg={msg} />
        </div>
      </form>
    </Card>
  );
}
