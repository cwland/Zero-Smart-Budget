import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, waitingNote } from "../api";
import { centsToInput, formatCents, parseMoney } from "../money";
import { openPlaidLink } from "../plaidLink";
import { PlusIcon } from "./Icons";
import { Popup } from "./Popup";
import { Toggle } from "./BudgetSettings";
import { CloseIcon } from "./Icons";

// The Accounts page: one card per bank (connected through Plaid) with its
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
type ManualType = "checking" | "savings" | "cash" | "credit" | "loan" | "investment" | "other" | "home" | "vehicle" | "asset";
interface ManualAccount {
  id: number;
  name: string;
  type: ManualType;
  balanceCents: number;
  signedCents: number;
  balanceUpdatedAt: string;
}
interface AccountsData {
  plaidOn: boolean; // Settings > Plaid switched on
  plaidReady: boolean;
  institutions: Institution[];
  manual: ManualAccount[];
  assets: ManualAccount[]; // home, vehicle, other things you own: in the total balance only
  totals: { haveCents: number; oweCents: number; netCents: number; assetsCents: number };
}

const TYPE_LABELS: Record<ManualType, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit card",
  loan: "Loan",
  investment: "Investment",
  other: "Other",
  home: "Home",
  vehicle: "Vehicle",
  asset: "Other asset",
};
const ACCOUNT_TYPES: ManualType[] = ["checking", "savings", "cash", "credit", "loan", "investment", "other"];
const ASSET_TYPES: ManualType[] = ["home", "vehicle", "asset"];
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
function BankBadge({ name, ok, small }: { name: string; ok: boolean; small?: boolean }) {
  return (
    <span className={`relative flex shrink-0 items-center justify-center rounded-full bg-primary font-bold text-white ${small ? "size-10 text-base" : "size-12 text-lg"}`} aria-hidden>
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

const input = "mt-1 w-full rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";

function ManualForm({ initial, asset, onSave, onDelete, onCancel }: { initial?: ManualAccount; asset?: boolean; onSave: (a: { name: string; type: ManualType; balanceCents: number }) => Promise<void>; onDelete?: () => Promise<void>; onCancel: () => void }) {
  const isAsset = asset ?? (initial ? ASSET_TYPES.includes(initial.type) : false);
  const types = isAsset ? ASSET_TYPES : ACCOUNT_TYPES;
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ManualType>(initial?.type ?? types[0]);
  const [balance, setBalance] = useState(initial ? centsToInput(initial.balanceCents) : "");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = balance.trim() ? parseMoney(balance) : 0;
    if (!name.trim()) return setError(isAsset ? "Give the asset a name" : "Give the account a name");
    if (cents === null) return setError("Balance isn't a valid amount");
    try {
      await onSave({ name: name.trim(), type, balanceCents: cents });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5" aria-label={initial ? (isAsset ? "Edit asset" : "Edit account") : isAsset ? "Add asset" : "Add account"}>
      {isAsset && <p className="rounded-lg bg-page px-3 py-2 text-sm text-subtle">Things you own, like your home or a car. Their value counts toward your total balance, but they're never part of your budget.</p>}
      <label className="font-semibold">
        {isAsset ? "Asset Name" : "Account Name"}
        <input autoFocus aria-label={isAsset ? "Asset name" : "Account name"} value={name} onChange={(e) => setName(e.target.value)} placeholder={isAsset ? "e.g. House, 2021 Tacoma, Boat" : "e.g. Cash envelope, 401(k), Car loan"} className={`${input} font-normal`} />
      </label>
      <label className="font-semibold">
        Type
        <select aria-label="Account type" value={type} onChange={(e) => setType(e.target.value as ManualType)} className={`${input} font-normal`}>
          {types.map((v) => (
            <option key={v} value={v}>
              {TYPE_LABELS[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="font-semibold">
        {isAsset ? "Current Value" : isDebt(type) ? "Amount Owed" : "Balance"}
        <input aria-label={isAsset ? "Current value" : isDebt(type) ? "Amount owed" : "Balance"} inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="$0.00" className={`${input} tabular font-normal`} />
        <span className="mt-1 block text-sm font-normal text-subtle">{isAsset ? "What it's worth today. Update it whenever you like." : "You update this yourself whenever it changes."}</span>
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
          {initial ? "Save" : isAsset ? "Add Asset" : "Add Account"}
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
                <input type="checkbox" checked={!!on.get(a.id)} onChange={(e) => setOn((m) => new Map(m).set(a.id, e.target.checked))} aria-label={`Import transactions from ${a.name}`} className="size-4 accent-action" />
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

function Row({ name, sub, cents, onClick, selected }: { name: string; sub?: string; cents: number | null; onClick?: () => void; selected?: boolean }) {
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
        <button
          onClick={onClick}
          aria-pressed={selected}
          data-selected-account={selected ? "" : undefined}
          className={`-mx-6 flex w-[calc(100%+3rem)] items-center gap-4 px-6 py-5 text-left transition-shadow ${
            selected ? "relative z-10 rounded-xl bg-white shadow-[0_6px_24px_rgba(31,36,38,0.16)] md:-mx-8 md:w-[calc(100%+4rem)] md:px-8" : "hover:bg-pressed"
          }`}
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-4 py-5">{content}</div>
      )}
    </li>
  );
}

// The side panel for one account (like the detail panel in other budgeting apps): its balance,
// and for a bank account the switch that turns importing its transactions on or off.
function AccountPanel({
  data,
  selected,
  onClose,
  onEdit,
  onChanged,
  onError,
}: {
  data: AccountsData;
  selected: { kind: "bank" | "manual"; id: number };
  onClose: () => void;
  onEdit: (a: ManualAccount) => void;
  onChanged: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const inst = selected.kind === "bank" ? data.institutions.find((i) => i.accounts.some((a) => a.id === selected.id)) : undefined;
  const bank = inst?.accounts.find((a) => a.id === selected.id);
  const manual = selected.kind === "manual" ? [...data.manual, ...data.assets].find((m) => m.id === selected.id) : undefined;
  const gone = !bank && !manual; // e.g. just deleted
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (gone) return null;
  const cents = bank ? bank.balanceCents : manual!.signedCents;
  const isAsset = !!manual && ASSET_TYPES.includes(manual.type);

  async function setImport(on: boolean) {
    if (!bank) return;
    setSaving(true);
    try {
      await api("PATCH", `/api/plaid/accounts/${bank.id}`, { importTransactions: on });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside aria-label="Account details" data-account-panel className="rounded-2xl bg-white p-6">
      <div className="flex items-start gap-3">
        {inst ? (
          <BankBadge name={inst.institutionName} ok={inst.status === "ok"} small />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-page text-lg" aria-hidden>
            {isAsset ? "🏠" : "✍️"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate pt-1.5 text-lg text-subtle">{inst ? inst.institutionName : isAsset ? "Asset" : "Manual account"}</span>
        <button onClick={onClose} aria-label="Close" className="rounded p-1 text-subtle hover:bg-page hover:text-ink">
          <CloseIcon className="size-6" />
        </button>
      </div>

      <h2 className="mt-4 text-xl font-bold leading-snug">
        {bank ? bank.officialName || bank.name : manual!.name}
        {bank?.mask && <span className="whitespace-nowrap"> *{bank.mask}</span>}
      </h2>
      <div className={`tabular mt-1 text-4xl font-bold ${cents !== null && cents < 0 ? "text-error" : ""}`}>{cents === null ? "—" : `${cents < 0 ? "-" : ""}${formatCents(Math.abs(cents))}`}</div>
      <p className="mt-1 text-sm text-subtle">
        {bank
          ? [bank.subtype ? bank.subtype.replace(/\b\w/g, (c) => c.toUpperCase()) : bank.type, inst!.active ? `synced ${ago(inst!.lastSyncedAt)}` : "paused"].join(" · ")
          : `${TYPE_LABELS[manual!.type]} · updated ${ago(manual!.balanceUpdatedAt)}`}
      </p>

      {bank && (
        <div className="mt-6 rounded-2xl bg-page p-5">
          <Toggle
            label="Import transactions"
            checked={bank.importTransactions}
            disabled={saving}
            onChange={(on) => void setImport(on)}
            text={<span className="font-semibold">{bank.importTransactions ? "Transaction importing is on" : "Transaction importing is off"}</span>}
          />
          <p className="mt-1 text-sm text-subtle">
            {bank.importTransactions
              ? `New transactions from this account come in through Plaid each time ${inst!.institutionName} syncs (every few hours), or right away with Sync now in the ⋯ menu.`
              : "New transactions from this account aren't brought in. Ones already imported stay, and the balance still updates."}
          </p>
        </div>
      )}

      {manual && (
        <div className="mt-6 rounded-2xl bg-page p-5">
          <p className="text-sm text-subtle">{isAsset ? "Counts toward your total balance, never part of your budget." : "You keep this balance up to date yourself."}</p>
          <button onClick={() => onEdit(manual)} className="mt-3 rounded bg-primary px-4 py-2.5 font-semibold text-white hover:bg-primary-pressed">
            {isAsset ? "Edit asset" : "Update balance"}
          </button>
        </div>
      )}
    </aside>
  );
}

export default function AccountsPage() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [popup, setPopup] = useState<
    | { kind: "addManual" }
    | { kind: "addAsset" }
    | { kind: "editManual"; account: ManualAccount }
    | { kind: "import"; inst: Institution }
    | { kind: "remove"; inst: Institution; force: boolean }
    | null
  >(null);

  // The account open in the side panel (click a row; ✕ or Esc closes it)
  const [selected, setSelected] = useState<{ kind: "bank" | "manual"; id: number } | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !popup && setSelected(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [popup]);
  // A click anywhere outside the selected row and its panel closes it (popups excepted)
  useEffect(() => {
    if (!selected) return;
    const outside = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest("[data-account-panel], [data-selected-account], [role=dialog]")) return;
      setSelected(null);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [selected]);
  const pick = (kind: "bank" | "manual", id: number) => setSelected((s) => (s?.kind === kind && s.id === id ? null : { kind, id }));
  const isSel = (kind: "bank" | "manual", id: number) => selected?.kind === kind && selected.id === id;

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
                  {inst.status === "ok" || !data.plaidOn ? (
                    <p className="text-subtle">
                      {inst.active ? `Synced through Plaid ${ago(inst.lastSyncedAt)}` : !data.plaidOn ? "Paused: Plaid is turned off in Settings" : "Paused: your Plaid keys are set to the other environment"}
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
                    ...(inst.active ? [{ label: busy === "sync" ? "Syncing…" : "Sync now", icon: "↻", onClick: update }] : []),
                    ...(data.plaidOn ? [{ label: "Reconnect", icon: "🔑", onClick: () => reconnect(inst) }] : []),
                    { label: "Import Settings", icon: "⚙", onClick: () => setPopup({ kind: "import", inst }) },
                    { label: "Disconnect bank", icon: "🗑", danger: true, onClick: () => setPopup({ kind: "remove", inst, force: false }) },
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
                    selected={isSel("bank", a.id)}
                    onClick={() => pick("bank", a.id)}
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
                  <p className="text-subtle">Balances you update yourself.</p>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {data.manual.map((m) => (
                  <Row key={m.id} name={m.name} sub={`${TYPE_LABELS[m.type]} · updated ${ago(m.balanceUpdatedAt)}`} cents={m.signedCents} selected={isSel("manual", m.id)} onClick={() => pick("manual", m.id)} />
                ))}
              </ul>
            </section>
          )}

          {!!data?.assets.length && (
            <section aria-label="Assets" className="rounded-2xl bg-white px-6 pt-6">
              <div className="flex items-start gap-3 border-b border-line pb-5">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-page text-2xl" aria-hidden>
                  🏠
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-bold">Assets</h2>
                  <p className="text-subtle">Count toward your total balance, never part of your budget.</p>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {data.assets.map((m) => (
                  <Row key={m.id} name={m.name} sub={`${TYPE_LABELS[m.type]} · updated ${ago(m.balanceUpdatedAt)}`} cents={m.signedCents} selected={isSel("manual", m.id)} onClick={() => pick("manual", m.id)} />
                ))}
              </ul>
            </section>
          )}

          {data && (
            <div className="flex flex-wrap items-center gap-x-10 gap-y-3 px-6">
              {data.plaidReady && (
                <button onClick={connect} disabled={!!busy} className="flex items-center gap-2 text-lg font-semibold text-action hover:underline disabled:opacity-50">
                  <span aria-hidden>⇄</span>
                  {busy === "connect" ? "Opening Plaid…" : "Link a Bank"}
                </button>
              )}
              <button onClick={() => setPopup({ kind: "addManual" })} className="flex items-center gap-2 text-lg font-semibold text-action hover:underline">
                <PlusIcon className="size-5" />
                Add Manual Account
              </button>
              <button onClick={() => setPopup({ kind: "addAsset" })} className="flex items-center gap-2 text-lg font-semibold text-action hover:underline">
                <PlusIcon className="size-5" />
                Add Asset
              </button>
            </div>
          )}
          {data && !data.plaidReady && (
            <p className="px-6 text-sm text-subtle">
              {data.plaidOn ? "To connect a bank, add your Plaid keys in " : "Bank syncing is turned off. To connect or sync banks, turn it on in "}
              <a href="#/settings/plaid" className="font-semibold text-link hover:underline">Settings › Plaid</a>.
            </p>
          )}
        </div>

        {/* Right side: the totals always, and the selected account's details below them */}
        {data && (t && (data.institutions.length > 0 || data.manual.length > 0 || data.assets.length > 0)) && (
          <div className="flex w-full shrink-0 flex-col gap-4 md:sticky md:top-6 md:w-[360px]">
            <aside aria-label="Totals" className="rounded-2xl bg-white p-5">
              <h2 className="text-lg font-semibold">Total Balance</h2>
              <div className={`tabular text-4xl font-semibold ${t.netCents < 0 ? "text-error" : "text-subtle"}`}>
                {t.netCents < 0 ? "-" : ""}
                {formatCents(Math.abs(t.netCents))}
              </div>
              <dl className="tabular mt-4 flex flex-col gap-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-subtle">What you have</dt>
                  <dd className="font-semibold">{formatCents(t.haveCents)}</dd>
                </div>
                {t.assetsCents > 0 && (
                  <div className="flex justify-between pl-3 text-xs">
                    <dt className="text-subtle">incl. assets</dt>
                    <dd className="text-subtle">{formatCents(t.assetsCents)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-subtle">What you owe</dt>
                  <dd className="font-semibold text-error">{t.oweCents ? `-${formatCents(t.oweCents)}` : formatCents(0)}</dd>
                </div>
              </dl>
            </aside>
            {selected && (
              <AccountPanel
                data={data}
                selected={selected}
                onClose={() => setSelected(null)}
                onEdit={(account) => setPopup({ kind: "editManual", account })}
                onChanged={load}
                onError={(text) => setMsg({ ok: false, text })}
              />
            )}
          </div>
        )}
      </div>

      {popup?.kind === "addManual" && (
        <Popup title="Add Manual Account" onClose={() => setPopup(null)}>
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
      {popup?.kind === "addAsset" && (
        <Popup title="Add Asset" onClose={() => setPopup(null)}>
          <ManualForm
            asset
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
        <Popup title="Disconnect bank" onClose={() => setPopup(null)}>
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
