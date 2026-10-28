import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { formatCents } from "../money";
import { openPlaidLink } from "../plaidLink";
import { Card, Notice, primaryButton, secondaryButton } from "./settingsUi";

interface Account {
  id: number;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  importTransactions: boolean;
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
}
interface Item {
  id: number;
  institutionName: string;
  env: "sandbox" | "production";
  active: boolean;
  status: "ok" | "login_required" | "error";
  errorMessage: string | null;
  lastSyncedAt: string | null;
  accounts: Account[];
}

const kind = (a: Account) => (a.subtype ? a.subtype.replace(/\b\w/g, (c) => c.toUpperCase()) : a.type);

export default function BankConnections() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string>(""); // what's running: "connect", "reconnect-3", ...
  const [removing, setRemoving] = useState<{ id: number; force: boolean } | null>(null);

  useEffect(() => {
    api<Item[]>("GET", "/api/plaid/items")
      .then(setItems)
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

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
      if (!result) return; // closed without connecting
      const list = await api<Item[]>("POST", "/api/plaid/exchange", result);
      setItems(list);
      setMsg({ ok: true, text: `Connected ${list[list.length - 1]?.institutionName ?? "your bank"}` });
    });

  const reconnect = (item: Item) =>
    run(`reconnect-${item.id}`, async () => {
      const { linkToken } = await api<{ linkToken: string }>("POST", "/api/plaid/link-token", { itemId: item.id });
      const result = await openPlaidLink(linkToken);
      if (!result) return;
      setItems(await api<Item[]>("POST", `/api/plaid/items/${item.id}/refresh`));
      setMsg({ ok: true, text: `${item.institutionName} is reconnected` });
    });

  // Flip the checkbox right away; put it back if saving fails
  const setImport = (id: number, on: boolean) =>
    setItems((list) => list?.map((i) => ({ ...i, accounts: i.accounts.map((x) => (x.id === id ? { ...x, importTransactions: on } : x)) })) ?? null);
  const toggle = (a: Account) => {
    const on = !a.importTransactions;
    setImport(a.id, on);
    setMsg(null);
    api("PATCH", `/api/plaid/accounts/${a.id}`, { importTransactions: on }).catch((e) => {
      setImport(a.id, !on);
      setMsg({ ok: false, text: (e as Error).message });
    });
  };

  const remove = (item: Item, force: boolean) =>
    run(`remove-${item.id}`, async () => {
      try {
        await api("DELETE", `/api/plaid/items/${item.id}${force ? "?force=true" : ""}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && !force) {
          setRemoving({ id: item.id, force: true });
          throw e;
        }
        throw e;
      }
      setItems((list) => (list ?? []).filter((i) => i.id !== item.id));
      setRemoving(null);
      setMsg({ ok: true, text: `Disconnected ${item.institutionName}` });
    });

  return (
    <Card
      title="Bank connections"
      description="Sign in to your bank in Plaid's window. Your bank password goes to Plaid, never to Cory's Dollar. Transactions you already imported stay if you disconnect."
    >
      <div className="flex flex-col gap-4">
        {items?.length === 0 && <p className="text-subtle">No banks connected yet.</p>}
        {items?.map((item) => (
          <section key={item.id} aria-label={item.institutionName} className="rounded-xl border border-line">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <h3 className="mr-auto font-semibold">
                {item.institutionName}
                {item.env === "sandbox" && <span className="ml-2 rounded bg-page px-2 py-0.5 text-xs font-semibold text-subtle">Sandbox</span>}
                {!item.active && <span className="ml-2 rounded bg-page px-2 py-0.5 text-xs font-semibold text-subtle">Paused: other environment selected</span>}
              </h3>
              {item.status === "ok" ? (
                <span className="text-sm text-success">Connected</span>
              ) : (
                <span role="alert" className="text-sm text-error">
                  {item.status === "login_required" ? "Needs you to sign in again" : item.errorMessage ?? "Problem with this connection"}
                </span>
              )}
              {item.status !== "ok" && (
                <button type="button" onClick={() => reconnect(item)} disabled={!!busy} className={secondaryButton + " !py-1.5"}>
                  {busy === `reconnect-${item.id}` ? "Opening…" : "Reconnect"}
                </button>
              )}
            </div>
            <ul className="divide-y divide-line">
              {item.accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {a.name}
                      {a.mask && <span className="text-subtle"> ••{a.mask}</span>}
                    </div>
                    <div className="text-sm text-subtle">
                      {kind(a)}
                      {a.currentBalanceCents !== null && <> · {a.type === "credit" ? "Owed" : "Balance"} {formatCents(a.currentBalanceCents)}</>}
                    </div>
                  </div>
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={a.importTransactions} onChange={() => toggle(a)} aria-label={`Import transactions from ${a.name}`} />
                    Import
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-4 py-2">
              {removing?.id === item.id ? (
                <>
                  <span className="text-sm text-subtle">{removing.force ? "Remove it here anyway?" : `Disconnect ${item.institutionName}?`}</span>
                  <button type="button" onClick={() => remove(item, removing.force)} disabled={!!busy} className="rounded bg-error px-3 py-1.5 text-sm font-semibold text-white">
                    {busy === `remove-${item.id}` ? "Removing…" : removing.force ? "Remove anyway" : "Disconnect"}
                  </button>
                  <button type="button" onClick={() => setRemoving(null)} className="px-2 text-sm text-subtle hover:underline">
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setRemoving({ id: item.id, force: false })} className="text-sm text-error hover:underline">
                  Disconnect
                </button>
              )}
            </div>
          </section>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={connect} disabled={!!busy} className={primaryButton}>
            {busy === "connect" ? "Opening Plaid…" : "Connect a bank"}
          </button>
          <Notice msg={msg} />
        </div>
      </div>
    </Card>
  );
}
