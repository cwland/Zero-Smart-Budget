import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { useSession } from "../session";
import { Card, field, primaryButton, secondaryButton } from "./settingsUi";

// Settings › Profile › Shared access (the owner only): invite people to this budget, change what
// they can do, or remove them. Everyone shares the one budget, each with their own sign-in.

type Role = "admin" | "user";
interface Person {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: "owner" | Role;
  createdAt: string;
  lastActiveAt: string | null;
}
interface Invite {
  id: number;
  name: string | null;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}
interface InviteResult {
  invite: Invite;
  token: string;
  link: string | null;
  emailed: boolean;
  emailError: string | null;
}

export const ROLE_INFO: Record<Role, { label: string; text: string }> = {
  admin: { label: "Admin", text: "Can see and do everything you can, including the app's settings, except shared access (inviting or removing people)." },
  user: { label: "User", text: "Uses the budget, transactions, accounts and reports like you do, but can't change the app's setup. Has their own profile, notifications and toss animation." },
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const errorText = (e: unknown) => (e instanceof ApiError && e.details?.[0]?.message) || (e as Error).message;
// The sign-up link: the server's own address when email is set up, otherwise this browser's
const linkFor = (r: InviteResult) => r.link ?? `${window.location.origin}${window.location.pathname}#/invite?token=${r.token}`;

function RoleBadge({ role }: { role: Person["role"] }) {
  const cls = role === "owner" ? "bg-primary text-white" : role === "admin" ? "bg-pressed text-primary" : "bg-page text-subtle";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{role === "owner" ? "Owner" : ROLE_INFO[role].label}</span>;
}

function RolePicker({ value, onChange, name }: { value: Role; onChange: (r: Role) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label="What they can do" className="grid gap-2 sm:grid-cols-2">
      {(["admin", "user"] as Role[]).map((r) => (
        <label key={r} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${value === r ? "border-action bg-pressed" : "border-line hover:border-strong"}`}>
          <input type="radio" name={name} checked={value === r} onChange={() => onChange(r)} className="mt-1 accent-[var(--color-action)]" />
          <span>
            <span className="block font-semibold">{ROLE_INFO[r].label}</span>
            <span className="block text-sm text-subtle">{ROLE_INFO[r].text}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

// The link to send, with a Copy button (and what happened to the email)
function LinkBox({ result, onDone }: { result: InviteResult; onDone: () => void }) {
  const link = linkFor(result);
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      input.current?.select(); // no clipboard (an http address): selected, ready to copy
      document.execCommand?.("copy");
    }
    setCopied(true);
  };
  const who = result.invite.name || result.invite.email;
  return (
    <div role="status" className="rounded-lg border border-line bg-page p-4">
      {result.emailed ? (
        <p className="text-success">
          Invite emailed to <strong>{result.invite.email}</strong>. You can also send them this link yourself:
        </p>
      ) : (
        <p className="text-ink">
          {result.emailError ? (
            <>
              <span className="text-error">The email couldn't be sent ({result.emailError}).</span>{" "}
            </>
          ) : (
            <>Email isn't set up with the app's address, so nothing was emailed. </>
          )}
          Send <strong>{who}</strong> this link yourself:
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <input ref={input} readOnly aria-label="Invite link" value={link} onFocus={(e) => e.currentTarget.select()} className={`${field} mt-0 min-w-0 flex-1 font-mono text-sm`} />
        <button type="button" onClick={copy} className={secondaryButton}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-2 text-sm text-subtle">It works once, until {day(result.invite.expiresAt)}. Anyone with the link can use it, so only send it to them.</p>
      <button type="button" onClick={onDone} className="mt-3 text-sm font-semibold text-link hover:underline">
        Done
      </button>
    </div>
  );
}

function AddPerson({ onAdded, onCancel }: { onAdded: (r: InviteResult) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onAdded(await api<InviteResult>("POST", "/api/users/invites", { name: name.trim(), email: email.trim(), role }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a person" className="rounded-lg border border-line p-4">
      <h3 className="font-semibold">Add a person</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-subtle">
          Name <span className="font-normal text-muted">(optional)</span>
          <input aria-label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jess" className={field} />
        </label>
        <label className="text-sm font-medium text-subtle">
          Email
          <input aria-label="Their email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@example.com" className={field} required />
        </label>
      </div>
      <p className="mt-4 mb-2 text-sm font-medium text-subtle">What can they do?</p>
      <RolePicker value={role} onChange={setRole} name="new-role" />
      {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Sending…" : "Send invite"}
        </button>
        <button type="button" onClick={onCancel} className="px-2 font-semibold text-link hover:underline">
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function SharedAccess() {
  const { user } = useSession();
  const [data, setData] = useState<{ people: Person[]; invites: Invite[]; emailReady: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // "person:3" / "invite:2"
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ people: Person[]; invites: Invite[]; emailReady: boolean }>("GET", "/api/users")
      .then(setData)
      .catch((e) => setError(errorText(e)));
  const owner = user.role === "owner";
  useEffect(() => {
    if (owner) load();
  }, [owner]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!owner) return null;
  const others = data?.people.filter((p) => p.role !== "owner") ?? [];

  return (
    <Card title="Shared access" description="Invite people to share this budget. Each person gets their own sign-in, profile and notifications.">
      {!data && !error && <p className="text-subtle">Loading…</p>}
      {data && (
        <ul aria-label="People with access" className="divide-y divide-line border-y border-line">
          {data.people.map((p) => {
            const self = p.role === "owner";
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {p.displayName || p.username} {self && <span className="font-normal text-muted">(you)</span>}
                  </p>
                  <p className="truncate text-sm text-subtle">
                    {p.username}
                    {p.email ? ` · ${p.email}` : ""}
                  </p>
                </div>
                {self ? (
                  <RoleBadge role="owner" />
                ) : confirm === `person:${p.id}` ? (
                  <span className="flex items-center gap-2 text-sm">
                    Remove {p.displayName || p.username}?
                    <button type="button" disabled={busy} onClick={() => act(() => api("DELETE", `/api/users/${p.id}`))} className="rounded bg-error px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                      Remove
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className="px-1 font-semibold text-link hover:underline">
                      Keep
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <select
                      aria-label={`What ${p.displayName || p.username} can do`}
                      value={p.role}
                      disabled={busy}
                      onChange={(e) => act(() => api("PATCH", `/api/users/${p.id}`, { role: e.target.value }))}
                      className="rounded border border-muted/50 bg-white px-2 py-1.5 text-sm"
                    >
                      <option value="admin">Admin</option>
                      <option value="user">User</option>
                    </select>
                    <button type="button" onClick={() => setConfirm(`person:${p.id}`)} className="rounded px-3 py-1.5 text-sm font-semibold text-error hover:bg-error-subtle">
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {data.invites.map((i) => (
            <li key={`i${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {i.name || i.email} <span className="font-normal text-muted">· invited</span>
                </p>
                <p className="truncate text-sm text-subtle">
                  {i.name ? `${i.email} · ` : ""}
                  {i.expired ? <span className="text-error">Link expired {day(i.expiresAt)}</span> : `Link works until ${day(i.expiresAt)}`}
                </p>
              </div>
              <RoleBadge role={i.role} />
              {confirm === `invite:${i.id}` ? (
                <span className="flex items-center gap-2 text-sm">
                  Cancel this invite?
                  <button type="button" disabled={busy} onClick={() => act(() => api("DELETE", `/api/users/invites/${i.id}`))} className="rounded bg-error px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                    Cancel invite
                  </button>
                  <button type="button" onClick={() => setConfirm(null)} className="px-1 font-semibold text-link hover:underline">
                    Keep
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        setAdding(false);
                        setResult(await api<InviteResult>("POST", `/api/users/invites/${i.id}/renew`));
                      })
                    }
                    className="rounded px-3 py-1.5 text-sm font-semibold text-link hover:bg-pressed"
                    title="Makes a new link (the old one stops working) and emails it again"
                  >
                    {data.emailReady ? "Resend" : "New link"}
                  </button>
                  <button type="button" onClick={() => setConfirm(`invite:${i.id}`)} className="rounded px-3 py-1.5 text-sm font-semibold text-error hover:bg-error-subtle">
                    Cancel
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && !others.length && !data.invites.length && <p className="mt-3 text-subtle">Only you have access right now.</p>}
      {error && <p role="alert" className="mt-3 rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

      <div className="mt-4">
        {result ? (
          <LinkBox result={result} onDone={() => setResult(null)} />
        ) : adding ? (
          <AddPerson
            onCancel={() => setAdding(false)}
            onAdded={(r) => {
              setAdding(false);
              setResult(r);
              load();
            }}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={secondaryButton}>
            + Add a person
          </button>
        )}
      </div>
      {data && !data.emailReady && !result && !adding && (
        <p className="mt-3 text-sm text-subtle">
          Email isn't set up with the app's address (Settings › <a href="#/settings/email" className="font-semibold text-link hover:underline">Email</a>), so you'll copy each invite link and send it yourself.
        </p>
      )}
    </Card>
  );
}
