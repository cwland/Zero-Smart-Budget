import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { useSession } from "../session";

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const field = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
const primary = "rounded bg-primary px-4 py-2.5 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// Copy text; falls back to selecting it when the browser blocks the clipboard (plain http on a LAN address)
async function copyText(text: string, input: HTMLInputElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!input) return false;
    input.focus();
    input.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

export function ChangePassword() {
  const { replaceToken } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) return setMsg({ ok: false, text: "New password must be at least 8 characters" });
    if (next !== confirm) return setMsg({ ok: false, text: "New passwords don't match" });
    setBusy(true);
    try {
      const res = await api<{ token: string }>("POST", "/api/auth/password", { currentPassword: current, newPassword: next });
      replaceToken(res.token);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password">
      <form data-password-form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium text-subtle">
          Current password
          <input type="password" autoComplete="current-password" aria-label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} required />
        </label>
        <label className="text-sm font-medium text-subtle">
          New password
          <input type="password" autoComplete="new-password" aria-label="New password" value={next} onChange={(e) => setNext(e.target.value)} className={field} required />
        </label>
        <label className="text-sm font-medium text-subtle">
          Confirm new password
          <input type="password" autoComplete="new-password" aria-label="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} required />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button type="submit" disabled={busy} className={primary}>
            Change password
          </button>
          {msg && (
            <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-success" : "text-error"}>
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const keyRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => setKeys(await api<ApiKey[]>("GET", "/api/keys")), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("Name the key after what will use it, like n8n or Home Assistant");
    try {
      const res = await api<{ name: string; key: string }>("POST", "/api/keys", { name: name.trim() });
      setCreated(res);
      setCopied(false);
      setName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: number) {
    try {
      await api("DELETE", `/api/keys/${id}`);
      setConfirmId(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const origin = window.location.origin;
  const now = new Date();
  const ym = `${now.getFullYear()}/${now.getMonth() + 1}`;
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const sampleKey = created?.key ?? "YOUR_KEY";

  return (
    <Card title="API keys">
      <p className="text-subtle">Let other apps (n8n, Home Assistant, scripts) read and update your budget. Each app should get its own key so you can revoke it separately.</p>

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 text-sm font-medium text-subtle">
          Key name
          <input aria-label="Key name" placeholder="e.g. n8n" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <button type="submit" className={primary}>
          Create key
        </button>
      </form>
      {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

      {created && (
        <div role="region" aria-label="New API key" className="mt-4 rounded-lg border border-success/40 bg-success-subtle/50 p-4">
          <p className="font-semibold">Key for "{created.name}" created</p>
          <p className="text-sm text-subtle">Copy it now. For safety it can't be shown again.</p>
          <div className="mt-2 flex gap-2">
            <input ref={keyRef} readOnly aria-label="New key" value={created.key} onFocus={(e) => e.currentTarget.select()} className="tabular min-w-0 flex-1 rounded border border-strong bg-white px-3 py-2 font-mono text-sm" />
            <button
              type="button"
              onClick={async () => setCopied(await copyText(created.key, keyRef.current))}
              className="rounded border border-primary px-4 py-2 font-semibold text-primary hover:bg-pressed"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" onClick={() => setCreated(null)} className="mt-3 text-sm font-semibold text-link hover:underline">
            Done
          </button>
        </div>
      )}

      <ul aria-label="API keys" className="mt-4 divide-y divide-line">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{k.name}</span>
              <span className="block text-sm text-subtle">
                <code className="font-mono">{k.prefix}…</code> · created {when(k.createdAt)} · {k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : "never used"}
              </span>
            </span>
            <button
              onClick={() => (confirmId === k.id ? revoke(k.id) : setConfirmId(k.id))}
              onBlur={() => setConfirmId(null)}
              aria-label={confirmId === k.id ? `Confirm revoke ${k.name}` : `Revoke ${k.name}`}
              className={`rounded px-3 py-1.5 text-sm font-semibold ${confirmId === k.id ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
            >
              {confirmId === k.id ? "Revoke for good?" : "Revoke"}
            </button>
          </li>
        ))}
        {keys.length === 0 && <li className="py-3 text-subtle">No API keys yet</li>}
      </ul>

      <details className="mt-4 rounded-lg bg-page p-4 text-sm">
        <summary className="cursor-pointer font-semibold">How to use a key</summary>
        <p className="mt-2 text-subtle">
          Send it in an <code className="font-mono">X-API-Key</code> header. Money is in whole cents (<code className="font-mono">1050</code> = $10.50).
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-ink p-3 font-mono text-xs leading-relaxed text-white">{`# This month's budget
curl -H "X-API-Key: ${sampleKey}" ${origin}/api/months/${ym}

# Add a transaction (unassigned)
curl -X POST -H "X-API-Key: ${sampleKey}" -H "Content-Type: application/json" \\
  -d '{"date":"${todayIso}","merchant":"Costco","amountCents":4567}' \\
  ${origin}/api/transactions

# Sinking fund balances
curl -H "X-API-Key: ${sampleKey}" ${origin}/api/funds`}</pre>
        <p className="mt-2 text-subtle">The full route list is in the project README.</p>
      </details>
    </Card>
  );
}

export function Devices() {
  const { replaceToken, signOutEverywhere } = useSession();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"others" | "all" | null>(null);

  async function others() {
    if (confirm !== "others") return setConfirm("others");
    setConfirm(null);
    try {
      const res = await api<{ token: string }>("POST", "/api/auth/logout-all", { keepThisDevice: true });
      replaceToken(res.token);
      setMsg({ ok: true, text: "Every other device was signed out" });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <Card title="Signed-in devices">
      <p className="text-subtle">If you signed in somewhere you no longer use (or lost a phone), sign out everywhere else. API keys aren't affected; revoke those separately.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={others} onBlur={() => setConfirm(null)} className={`rounded px-4 py-2.5 font-semibold ${confirm === "others" ? "bg-error text-white" : "border border-primary text-primary hover:bg-pressed"}`}>
          {confirm === "others" ? "Yes, sign out other devices" : "Sign out other devices"}
        </button>
        <button
          onClick={() => (confirm === "all" ? void signOutEverywhere() : setConfirm("all"))}
          onBlur={() => setConfirm(null)}
          className={`rounded px-4 py-2.5 font-semibold ${confirm === "all" ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
        >
          {confirm === "all" ? "Yes, including this one" : "Sign out everywhere"}
        </button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-success" : "text-error"}>
            {msg.text}
          </span>
        )}
      </div>
    </Card>
  );
}
