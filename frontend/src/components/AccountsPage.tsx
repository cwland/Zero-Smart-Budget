import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, waitingNote } from "../api";
import { centsToInput, formatCents, parseMoney } from "../money";
import { openPlaidLink } from "../plaidLink";
import { useLockBodyScroll } from "../scrollLock";
import { PlusIcon } from "./Icons";

// The Accounts page, like EveryDollar's: one card per bank (connected through Plaid) with its
// accounts and balances, plus accounts you keep track of by hand.

interface BankAccount {
  id: number;
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  importTransactions: boolean;
  balanceCents: number | null; // what you owe is negative
}
interface Institution {
  id: number;
  institutionName: string;
  env: "sandbox" | "production";
  active: boolean;
  status: "ok" | "login_required" | "error";
  errorMessage: string | null;
  lastSyncedAt: string | null;
  importFrom: string;
  accounts: BankAccount[];
}
type ManualType = "checking" | "savings" | "cash" | "credit" | "loan" | "investment" | "other";
interface ManualAccount {
  id: number;
  name: string;
  type: ManualType;
  balanceCents: number;
  signedCents: number;
  balanceUpdatedAt: string;
}
interface AccountsData {
  plaidReady: boolean;
  institutions: Institution[];
  manual: ManualAccount[];
  totals: { haveCents: number; oweCents: number; netCents: number };
}

const TYPE_LABELS: Record<ManualType, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit card",
  loan: "Loan",
  investment: "Investment",
  other: "Other",
};
const isDebt = (t: string) => t === "credit" || t === "loan";

// "15 hours ago"
function ago(iso: string | null) {
  if (!iso) return "not yet";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(of|the|and|&)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

// A round badge with the bank's initials, and a check (or a warning) on the corner
function BankBadge({ name, ok }: { name: string; ok: boolean }) {
  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-white" aria-hidden>
      {initials(name) || "🏦"}
      <span className={`absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white ${ok ? "bg-success" : "bg-error"}`}>{ok ? "✓" : "!"}</span>
    </span>
  );
}

// The ⋯ menu on a card
function Menu({ label, items }: { label: string; items: { label: string; icon?: string; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={label} aria-expanded={open} className={`flex size-10 items-center justify-center rounded-lg text-xl font-bold leading-none text-ink hover:bg-page ${open ? "border-2 border-action" : ""}`}>
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-20 min-w-52 rounded-xl bg-white py-2 shadow-[0_8px_28px_rgba(31,36,38,0.18)]">
          {items.map((i) => (
            <button
              key={i.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={`flex w-full items-center gap-3 px-5 py-3 text-left font-medium hover:bg-page ${i.danger ? "text-error" : "text-ink"}`}
            >
              {i.icon && <span className="w-4 text-center" aria-hidden>{i.icon}</span>}
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A centered popup
function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useLockBodyScroll();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[94vh] w-full max-w-[28rem] flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_12px_40px_rgba(31,36,38,0.3)] sm:rounded-2xl">
        <header className="relative flex items-center justify-center bg-page px-12 py-5">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1.5 text-subtle hover:bg-white/70 hover:text-ink">
            ✕
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body
  );
}

const input = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";

function ManualForm({ initial, onSave, onDelete, onCancel }: { initial?: ManualAccount; onSave: (a: { name: string; type: ManualType; balanceCents: number }) => Promise<void>; onDelete?: () => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ManualType>(initial?.type ?? "checking");
  const [balance, setBalance] = useState(initial ? centsToInput(initial.balanceCents) : "");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = balance.trim() ? parseMoney(balance) : 0;
    if (!name.trim()) return setError("Give the account a name");
    if (cents === null) return setError("Balance isn't a valid amount");
    try {
      await onSave({ name: name.trim(), type, balanceCents: cents });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5" aria-label={initial ? "Edit account" : "Add account"}>
      <label className="font-semibold">
        Account Name
        <input autoFocus aria-label="Account name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cash envelope, 401(k), Car loan" className={`${input} font-normal`} />
      </label>
      <label className="font-semibold">
        Type
        <select aria-label="Account type" value={type} onChange={(e) => setType(e.target.value as ManualType)} className={`${input} font-normal`}>
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="font-semibold">
        {isDebt(type) ? "Amount Owed" : "Balance"}
        <input aria-label={isDebt(type) ? "Amount owed" : "Balance"} inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="$0.00" className={`${input} tabular font-normal`} />
        <span className="mt-1 block text-sm font-normal text-subtle">You update this yourself whenever it changes.</span>
      </label>
      {error && <p role="alert" className="rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
      <div className="flex items-center justify-end gap-3 pt-2">
        {onDelete && (
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`mr-auto rounded px-3 py-2 text-sm font-semibold ${confirmDelete ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
          >
            {confirmDelete ? "Delete for good?" : "Delete"}
          </button>
        )}
        <button type="button" onClick={onCancel} className="rounded px-4 py-3 font-semibold text-action hover:bg-pressed">
          Cancel
        </button>
        <button type="submit" className="rounded bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed">
          {initial ? "Save" : "Add Account"}
        </button>
      </div>
    </form>
  );
}

// Which accounts to import from, and from what date
function ImportSettings({ inst, onChanged, onClose }: { inst: Institution; onChanged: () => Promise<void>; onClose: () => void }) {
  const [from, setFrom] = useState(inst.importFrom);
  const [on, setOn] = useState(() => new Map(inst.accounts.map((a) => [a.id, a.importTransactions])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      for (const a of inst.accounts) {
        if (on.get(a.id) !== a.importTransactions) await api("PATCH", `/api/plaid/accounts/${a.id}`, { importTransactions: on.get(a.id) });
      }
      if (from && from !== inst.importFrom) await api("PATCH", `/api/plaid/items/${inst.id}`, { importFrom: from });
      await onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4 p-5">
      <label className="font-semibold">
        Import transactions from
        <input type="date" aria-label="Import from" value={from} onChange={(e) => setFrom(e.target.value)} className={`${input} font-normal`} />
        <span className="mt-1 block text-sm font-normal text-subtle">Picking an earlier date brings in older transactions on the next update.</span>
      </label>
      <fieldset>
        <legend className="font-semibold">Import from these accounts</legend>
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {inst.accounts.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                <input type="checkbox" checked={!!on.get(a.id)} onChange={(e) => setOn((m) => new Map(m).set(a.id, e.target.checked))} aria-label={`Import transactions from ${a.name}`} className="size-4 accent-[#0073b9]" />
                <span className="min-w-0 flex-1 truncate">
                  {a.name}
                  {a.mask && <span className="text-subtle"> ••{a.mask}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {error && <p role="alert" className="rounded bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="rounded px-4 py-3 font-semibold text-action hover:bg-pressed">
          Cancel
        </button>
        <button disabled={busy} onClick={save} className="rounded bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-pressed disabled:opacity-50">
          Save
        </button>
      </div>
    </div>
  );
}

function Row({ name, sub, cents, onClick }: { name: string; sub?: string; cents: number | null; onClick?: () => void }) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-semibold">{name}</span>
        {sub && <span className="block truncate text-sm text-subtle">{sub}</span>}
      </span>
      <span className={`tabular shrink-0 text-lg font-semibold ${cents !== null && cents < 0 ? "text-error" : ""}`}>{cents === null ? "—" : `${cents < 0 ? "-" : ""}${formatCents(Math.abs(cents))}`}</span>
    </>
  );
  return (
    <li>
      {onClick ? (
        <button onClick={onClick} className="-mx-6 flex w-[calc(100%+3rem)] items-center gap-4 px-6 py-5 text-left hover:bg-pressed">
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-4 py-5">{content}</div>
      )}
    </li>
  );
}

export default function AccountsPage() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [popup, setPopup] = useState<
    | { kind: "addManual" }
    | { kind: "editManual"; account: ManualAccount }
    | { kind: "import"; inst: Institution }
    | { kind: "remove"; inst: Institution; force: boolean }
    | null
  >(null);

  const load = useCallback(async () => setData(await api<AccountsData>("GET", "/api/accounts")), []);
  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: e.message }));
  }, [load]);

  async function run(what: string, fn: () => Promise<void>) {
    setMsg(null);
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const connect = () =>
    run("connect", async () => {
      const { linkToken } = await api<{ linkToken: string }>("POST", "/api/plaid/link-token", {});
      const result = await openPlaidLink(linkToken);
      if (!result) return;
      const list = await api<Institution[]>("POST", "/api/plaid/exchange", result);
      await load();
      setMsg({ ok: true, text: `Connected ${list[list.length - 1]?.institutionName ?? "your bank"}. Its transactions come in on the next update.` });
    });

  const update = () =>
    run("sync", async () => {
      const r = await api<{ added: number; updated: number; removed: number; results: { error?: string }[]; waiting: { year: number; month: number; count: number }[] }>("POST", "/api/plaid/sync");
      await load();
      const problems = r.results.filter((x) => x.error).map((x) => x.error);
      if (problems.length) throw new Error(problems.join(" "));
      const parts = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
      setMsg({ ok: true, text: (parts.length ? `Updated: ${parts.join(", ")} transactions. New ones wait in the Transactions tab.` : "Updated: nothing new.") + waitingNote(r.waiting) });
    });

  const reconnect = (inst: Institution) =>
    run(`reconnect-${inst.id}`, async () => {
      const { linkToken } = await api<{ linkToken: string }>("POST", "/api/plaid/link-token", { itemId: inst.id });
      const result = await openPlaidLink(linkToken);
      if (!result) return;
      await api("POST", `/api/plaid/items/${inst.id}/refresh`);
      await load();
      setMsg({ ok: true, text: `${inst.institutionName} is reconnected` });
    });

  const remove = (inst: Institution, force: boolean) =>
    run(`remove-${inst.id}`, async () => {
      try {
        await api("DELETE", `/api/plaid/items/${inst.id}${force ? "?force=true" : ""}`);
      } catch (e) {
        // Plaid couldn't be told: offer to remove it here anyway
        if (e instanceof ApiError && e.status === 409 && !force) {
          setPopup({ kind: "remove", inst, force: true });
        }
        throw e;
      }
      setPopup(null);
      await load();
      setMsg({ ok: true, text: `Removed ${inst.institutionName}. Transactions already imported stay.` });
    });

  const t = data?.totals;
  return (
    <div className="mx-auto max-w-[1100px] px-3 pb-16 pt-8 sm:px-6">
      <h1 className="text-4xl font-bold">Accounts</h1>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`mt-4 flex items-start justify-between gap-3 rounded-lg px-4 py-3 ${msg.ok ? "bg-brand-subtle text-success" : "bg-error-subtle text-error"}`}>
          {msg.text}
          <button onClick={() => setMsg(null)} aria-label="Dismiss" className="text-subtle">✕</button>
        </p>
      )}

      <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-8 md:max-w-[680px]">
          {!data && <p className="text-subtle">Loading…</p>}

          {data?.institutions.map((inst) => (
            <section key={inst.id} aria-label={inst.institutionName} className="rounded-2xl bg-white px-6 pt-6">
              <div className="flex items-start gap-3 border-b border-line pb-5">
                <BankBadge name={inst.institutionName} ok={inst.status === "ok"} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold">
                    {inst.institutionName}
                    {inst.env === "sandbox" && <span className="ml-2 rounded bg-page px-2 py-0.5 align-middle text-xs font-semibold text-subtle">Sandbox</span>}
                  </h2>
                  {inst.status === "ok" ? (
                    <p className="text-subtle">
                      {inst.active ? `Auto-updated by Plaid ${ago(inst.lastSyncedAt)}` : "Paused: your Plaid keys are set to the other environment"}
                    </p>
                  ) : (
                    <p role="alert" className="text-error">
                      {inst.status === "login_required" ? "Needs you to sign in again." : inst.errorMessage ?? "There's a problem with this connection."}{" "}
                      <button onClick={() => reconnect(inst)} disabled={!!busy} className="font-semibold text-link hover:underline">
                        {busy === `reconnect-${inst.id}` ? "Opening…" : "Reconnect"}
                      </button>
                    </p>
                  )}
                </div>
                <Menu
                  label={`${inst.institutionName} options`}
                  items={[
                    ...(inst.active ? [{ label: busy === "sync" ? "Updating…" : "Update Accounts", icon: "↻", onClick: update }] : []),
                    { label: "Reconnect", icon: "🔑", onClick: () => reconnect(inst) },
                    { label: "Import Settings", icon: "⚙", onClick: () => setPopup({ kind: "import", inst }) },
                    { label: "Remove Institution", icon: "🗑", danger: true, onClick: () => setPopup({ kind: "remove", inst, force: false }) },
                  ]}
                />
              </div>
              <ul className="divide-y divide-line">
                {inst.accounts.map((a) => (
                  <Row
                    key={a.id}
                    name={a.name}
                    sub={[a.mask ? `••${a.mask}` : "", !a.importTransactions ? "Not importing transactions" : ""].filter(Boolean).join(" · ") || undefined}
                    cents={a.balanceCents}
                  />
                ))}
              </ul>
            </section>
          ))}

          {!!data?.manual.length && (
            <section aria-label="Manual accounts" className="rounded-2xl bg-white px-6 pt-6">
              <div className="flex items-start gap-3 border-b border-line pb-5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-page text-2xl" aria-hidden>
                  ✍️
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-bold">Manual Accounts</h2>
                  <p className="text-subtle">Balances you update yourself. Click one to change it.</p>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {data.manual.map((m) => (
                  <Row key={m.id} name={m.name} sub={`${TYPE_LABELS[m.type]} · updated ${ago(m.balanceUpdatedAt)}`} cents={m.signedCents} onClick={() => setPopup({ kind: "editManual", account: m })} />
                ))}
              </ul>
            </section>
          )}

          {data && (
            <div className="flex flex-wrap items-center gap-x-10 gap-y-3 px-6">
              {data.plaidReady && (
                <button onClick={connect} disabled={!!busy} className="flex items-center gap-2 text-lg font-semibold text-action hover:underline disabled:opacity-50">
                  <span aria-hidden>⇄</span>
                  {busy === "connect" ? "Opening Plaid…" : "Connect Account"}
                </button>
              )}
              <button onClick={() => setPopup({ kind: "addManual" })} className="flex items-center gap-2 text-lg font-semibold text-action hover:underline">
                <PlusIcon className="size-5" />
                Add Account Manually
              </button>
            </div>
          )}
          {data && !data.plaidReady && (
            <p className="px-6 text-sm text-subtle">
              To connect a bank, add your Plaid keys in <a href="#/settings/plaid" className="font-semibold text-link hover:underline">Settings › Plaid</a>.
            </p>
          )}
        </div>

        {t && (data.institutions.length > 0 || data.manual.length > 0) && (
          <aside aria-label="Totals" className="w-full shrink-0 rounded-2xl bg-white p-5 md:sticky md:top-6 md:w-[300px]">
            <h2 className="text-lg font-semibold">Net Worth</h2>
            <div className={`tabular text-4xl font-semibold ${t.netCents < 0 ? "text-error" : "text-subtle"}`}>
              {t.netCents < 0 ? "-" : ""}
              {formatCents(Math.abs(t.netCents))}
            </div>
            <dl className="tabular mt-4 flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-subtle">What you have</dt>
                <dd className="font-semibold">{formatCents(t.haveCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-subtle">What you owe</dt>
                <dd className="font-semibold text-error">{t.oweCents ? `-${formatCents(t.oweCents)}` : formatCents(0)}</dd>
              </div>
            </dl>
          </aside>
        )}
      </div>

      {popup?.kind === "addManual" && (
        <Popup title="Add Account Manually" onClose={() => setPopup(null)}>
          <ManualForm
            onCancel={() => setPopup(null)}
            onSave={async (a) => {
              await api("POST", "/api/accounts/manual", a);
              setPopup(null);
              await load();
            }}
          />
        </Popup>
      )}
      {popup?.kind === "editManual" && (
        <Popup title={popup.account.name} onClose={() => setPopup(null)}>
          <ManualForm
            initial={popup.account}
            onCancel={() => setPopup(null)}
            onSave={async (a) => {
              await api("PATCH", `/api/accounts/manual/${popup.account.id}`, a);
              setPopup(null);
              await load();
            }}
            onDelete={async () => {
              await api("DELETE", `/api/accounts/manual/${popup.account.id}`);
              setPopup(null);
              await load();
            }}
          />
        </Popup>
      )}
      {popup?.kind === "import" && (
        <Popup title={`${popup.inst.institutionName} import`} onClose={() => setPopup(null)}>
          <ImportSettings inst={popup.inst} onChanged={load} onClose={() => setPopup(null)} />
        </Popup>
      )}
      {popup?.kind === "remove" && (
        <Popup title="Remove Institution" onClose={() => setPopup(null)}>
          <div className="flex flex-col gap-4 p-5">
            <p>
              {popup.force
                ? `Plaid couldn't be reached to disconnect ${popup.inst.institutionName}. Remove it here anyway?`
                : `Disconnect ${popup.inst.institutionName}? Its accounts leave this page and no new transactions come in. Transactions already imported stay.`}
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPopup(null)} className="rounded px-4 py-3 font-semibold text-action hover:bg-pressed">
                Cancel
              </button>
              <button disabled={!!busy} onClick={() => remove(popup.inst, popup.force)} className="rounded bg-error px-6 py-3 font-semibold text-white disabled:opacity-50">
                {busy.startsWith("remove") ? "Removing…" : popup.force ? "Remove anyway" : "Remove"}
              </button>
            </div>
          </div>
        </Popup>
      )}
    </div>
  );
}
