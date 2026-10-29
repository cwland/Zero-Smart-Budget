import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { useSession } from "../session";

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  access: KeyAccess;
  createdAt: string;
  lastUsedAt: string | null;
}

type KeyAccess = "read" | "add" | "read_add";
// What a key may do (the server enforces the same list; see backend lib/keyAccess.ts)
const ACCESS: { value: KeyAccess; label: string; text: string }[] = [
  { value: "read", label: "Read only", text: "See budgets, transactions, funds, goals and accounts" },
  { value: "add", label: "Add transactions", text: "Add new transactions and start a bank sync, but can't see anything" },
  { value: "read_add", label: "Read + add transactions", text: "Both of the above" },
];
const accessLabel = (a: KeyAccess) => ACCESS.find((x) => x.value === a)?.label ?? a;

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const field = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";
const primary = "rounded bg-primary px-4 py-2.5 font-semibold text-white hover:bg-primary-pressed disabled:opacity-60";

function Card({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {title}
        {extra}
      </h2>
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
  const [showHelp, setShowHelp] = useState(false);

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
    <Card
      title="Change password"
      extra={
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          aria-label="How to reset the password by hand"
          aria-expanded={showHelp}
          title="Forgot it? How to reset the password by hand"
          className={`flex size-6 items-center justify-center rounded-full border text-sm font-bold ${showHelp ? "border-action bg-action text-white" : "border-strong text-subtle hover:border-action hover:text-action"}`}
        >
          i
        </button>
      }
    >
      {showHelp && <ManualReset />}
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

// Shown from the (i) on Change password: resetting it from the server when you can't sign in
function ManualReset() {
  return (
    <div role="region" aria-label="Reset the password by hand" className="mb-4 rounded-lg bg-page p-4 text-sm">
      <p className="font-semibold">Forgot your password?</p>
      <p className="mt-1 text-subtle">
        If email is set up, use <strong>Forgot password?</strong> on the sign-in page. If not, reset it on the computer that runs Zero Smart Budget. Open a terminal in the project folder and run one of these. It asks for the
        new password twice (nothing shows as you type).
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-ink p-3 font-mono text-xs leading-relaxed text-white">{`# Running it with npm (development)
cd backend && npm run reset-password

# Running it with Docker
docker compose exec api npm run reset-password`}</pre>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-subtle">
        <li>The password must be at least 8 characters.</li>
        <li>Every device is signed out afterwards. Sign in again with the new password.</li>
        <li>API keys keep working; they don't use the password.</li>
      </ul>
    </div>
  );
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<KeyAccess>("read");
  const [created, setCreated] = useState<{ name: string; key: string; access: KeyAccess } | null>(null);
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
      const res = await api<{ name: string; key: string; access: KeyAccess }>("POST", "/api/keys", { name: name.trim(), access });
      setCreated(res);
      setCopied(false);
      setName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function changeAccess(id: number, value: KeyAccess) {
    setError("");
    try {
      await api("PATCH", `/api/keys/${id}`, { access: value });
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
      <p className="text-subtle">
        Let other apps (n8n, Home Assistant, scripts) read your budget or add transactions. Give each app its own key, with only the access it needs, so you can change or revoke it separately. No key can change your plan, funds or settings.
      </p>

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 text-sm font-medium text-subtle">
          Key name
          <input aria-label="Key name" placeholder="e.g. n8n" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <button type="submit" className={primary}>
          Create key
        </button>
        <fieldset className="w-full">
          <legend className="text-sm font-medium text-subtle">What can it do?</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {ACCESS.map((a) => (
              <label key={a.value} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${access === a.value ? "border-action bg-action/5" : "border-line"}`}>
                <input type="radio" name="key-access" checked={access === a.value} onChange={() => setAccess(a.value)} className="mt-1 accent-action" />
                <span>
                  <span className="block font-semibold">{a.label}</span>
                  <span className="block text-sm text-subtle">{a.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </form>
      {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

      {created && (
        <div role="region" aria-label="New API key" className="mt-4 rounded-lg border border-success/40 bg-success-subtle/50 p-4">
          <p className="font-semibold">
            Key for "{created.name}" created · {accessLabel(created.access)}
          </p>
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
            <select
              aria-label={`Access for ${k.name}`}
              value={k.access}
              onChange={(e) => changeAccess(k.id, e.target.value as KeyAccess)}
              className="rounded border border-line bg-white px-2 py-1.5 text-sm"
            >
              {ACCESS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
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
          Send it in an <code className="font-mono">X-API-Key</code> header. Money is in whole cents (<code className="font-mono">1050</code> = $10.50). Reading needs a Read key; adding needs an Add key.
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

interface DeviceSession {
  id: number;
  current: boolean;
  status: "active" | "signed out" | "expired";
  device: { browser: string; os: string; label: string };
  userAgent: string | null;
  how: string;
  ip: string | null;
  lastIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  signedOutAt: string | null;
}
interface SignIn {
  id: number;
  at: string;
  username: string | null;
  success: boolean;
  reason: string | null;
  ip: string | null;
  device: { label: string };
}

const dateTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
const deviceIcon = (os: string) => (/iPhone|Android/.test(os) ? "📱" : /iPad/.test(os) ? "📲" : "💻");

export function Devices() {
  const { replaceToken, signOutEverywhere } = useSession();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"others" | "all" | `one-${number}` | null>(null);
  const [list, setList] = useState<DeviceSession[] | null>(null);
  const [showOld, setShowOld] = useState(false);

  const load = useCallback(() => api<DeviceSession[]>("GET", "/api/auth/sessions").then(setList), []);
  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, [load]);

  async function others() {
    if (confirm !== "others") return setConfirm("others");
    setConfirm(null);
    try {
      const res = await api<{ token: string }>("POST", "/api/auth/logout-all", { keepThisDevice: true });
      replaceToken(res.token);
      setMsg({ ok: true, text: "Every other device was signed out" });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  async function one(d: DeviceSession) {
    if (confirm !== `one-${d.id}`) return setConfirm(`one-${d.id}`);
    setConfirm(null);
    try {
      await api("DELETE", `/api/auth/sessions/${d.id}`);
      setMsg({ ok: true, text: `${d.device.label} was signed out` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const active = (list ?? []).filter((d) => d.status === "active").sort((a, b) => Number(b.current) - Number(a.current));
  const old = (list ?? []).filter((d) => d.status !== "active");
  const row = (d: DeviceSession) => (
    <li key={d.id} className="flex flex-wrap items-start gap-3 py-4">
      <span className="text-2xl" aria-hidden>
        {deviceIcon(d.device.os)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {d.device.label}
          {d.current && <span className="rounded-full bg-success-subtle px-2 py-0.5 text-xs font-semibold text-success">This device</span>}
          {d.status !== "active" && <span className="rounded-full bg-page px-2 py-0.5 text-xs font-semibold text-subtle">{d.status === "expired" ? "Expired" : "Signed out"}</span>}
          {d.status === "active" && !d.current && <span className="rounded-full bg-pressed px-2 py-0.5 text-xs font-semibold text-primary">Signed in</span>}
        </div>
        <dl className="mt-1 grid gap-x-6 gap-y-0.5 text-sm text-subtle sm:grid-cols-2">
          <div>
            <dt className="inline">Signed in: </dt>
            <dd className="inline">
              {dateTime(d.createdAt)} ({d.how})
            </dd>
          </div>
          <div>
            <dt className="inline">Last used: </dt>
            <dd className="inline">{d.current ? "now" : ago(d.lastSeenAt)}</dd>
          </div>
          <div>
            <dt className="inline">IP address: </dt>
            <dd className="inline font-mono text-xs">
              {d.lastIp ?? d.ip ?? "unknown"}
              {d.ip && d.lastIp && d.ip !== d.lastIp ? ` (signed in from ${d.ip})` : ""}
            </dd>
          </div>
          <div>
            <dt className="inline">{d.status === "signed out" ? "Signed out: " : d.status === "expired" ? "Expired: " : "Stays signed in until: "}</dt>
            <dd className="inline">{d.status === "signed out" && d.signedOutAt ? dateTime(d.signedOutAt) : dateTime(d.expiresAt)}</dd>
          </div>
        </dl>
      </div>
      {d.status === "active" && !d.current && (
        <button
          onClick={() => one(d)}
          onBlur={() => setConfirm(null)}
          className={`shrink-0 rounded px-3 py-1.5 text-sm font-semibold ${confirm === `one-${d.id}` ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
        >
          {confirm === `one-${d.id}` ? "Sign it out?" : "Sign out"}
        </button>
      )}
    </li>
  );

  return (
    <Card title="Signed-in devices">
      <p className="text-subtle">Every browser or device signed in to your account. Don't recognize one? Sign it out, then change your password. API keys aren't listed here; manage those separately.</p>
      {list && (
        <ul aria-label="Signed-in devices" className="mt-2 divide-y divide-line">
          {active.map(row)}
        </ul>
      )}
      {old.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowOld((v) => !v)} aria-expanded={showOld} className="text-sm font-semibold text-link hover:underline">
            {showOld ? "Hide" : "Show"} signed-out and expired devices ({old.length})
          </button>
          {showOld && <ul className="mt-1 divide-y divide-line opacity-80">{old.map(row)}</ul>}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
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

// Every sign-in attempt, good or bad
export function SignInHistory() {
  const [events, setEvents] = useState<SignIn[] | null>(null);
  const [shown, setShown] = useState(15);
  const [error, setError] = useState("");
  useEffect(() => {
    api<SignIn[]>("GET", "/api/auth/logins")
      .then(setEvents)
      .catch((e) => setError((e as Error).message));
  }, []);
  const failed = (events ?? []).filter((e) => !e.success && Date.now() - new Date(e.at).getTime() < 7 * 24 * 3600 * 1000).length;
  return (
    <Card title="Sign-in history">
      <p className="text-subtle">
        Every attempt to sign in, including ones that failed.
        {failed > 0 && <strong className="text-error"> {failed} failed in the last 7 days.</strong>}
      </p>
      {error && <p className="mt-2 text-error">{error}</p>}
      {events && events.length === 0 && <p className="mt-3 text-subtle">Nothing yet.</p>}
      {events && events.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-subtle">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-semibold">When</th>
                <th className="py-2 pr-3 font-semibold">Result</th>
                <th className="py-2 pr-3 font-semibold">Device</th>
                <th className="py-2 pr-3 font-semibold">IP address</th>
                <th className="py-2 font-semibold">Username typed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.slice(0, shown).map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap py-2 pr-3">{dateTime(e.at)}</td>
                  <td className="py-2 pr-3">
                    <span className={`font-semibold ${e.success ? "text-success" : "text-error"}`}>{e.success ? "✓ " : "✕ "}</span>
                    {e.reason}
                  </td>
                  <td className="py-2 pr-3">{e.device.label}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{e.ip ?? "unknown"}</td>
                  <td className="py-2">{e.username ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length > shown && (
            <button onClick={() => setShown((n) => n + 25)} className="mt-3 text-sm font-semibold text-link hover:underline">
              Show more ({events.length - shown} older)
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
