// TEMPORARY testing tool: reset button (bottom-left of the app, or in the Account menu on phones).
// To remove: delete this file and backend/src/routes/devReset.ts, then remove the lines that
// reference them in AppShell.tsx, AccountMenu.tsx and backend/src/app.ts.
import { useEffect, useState } from "react";
import { api, setToken } from "../api";
import { ResetIcon } from "./Icons";

type Scope = "transactions" | "budget" | "everything";

const OPTIONS: { id: Scope; title: string; detail: string }[] = [
  { id: "transactions", title: "Clear all transactions", detail: "Budgets, items and funds stay. Funds lose their spending history." },
  { id: "budget", title: "Reset all budget data", detail: "Deletes every month, transaction and fund. Your login, email settings and API keys stay." },
  { id: "everything", title: "Reset everything", detail: "Also deletes your account and settings. The app goes back to first-run setup." },
];

export function DevResetDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<Scope>("transactions");
  const [confirm, setConfirm] = useState("");
  const [reimportBank, setReimportBank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  async function reset() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ backup: string }>("POST", "/api/dev/reset", { scope, confirm, reimportBank });
      setDone(res.backup);
      if (scope === "everything") setToken(null);
      setTimeout(() => {
        window.location.hash = "#/budget";
        window.location.reload();
      }, 1200);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 p-3 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Reset (testing)" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_12px_32px_rgba(31,36,38,0.25)]">
        <div className="flex items-center gap-2">
          <span className="rounded bg-warning/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-[#a66b00]">Testing</span>
          <h2 className="text-lg font-semibold">Reset the app</h2>
        </div>

        {done ? (
          <p role="status" className="mt-4 rounded-lg bg-success-subtle px-4 py-3 text-success">
            Done. A backup was saved first ({done}), so Settings → Data → Restore can undo this. Reloading…
          </p>
        ) : (
          <>
            <div role="radiogroup" aria-label="What to reset" className="mt-4 flex flex-col gap-2">
              {OPTIONS.map((o) => (
                <label key={o.id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${scope === o.id ? "border-error bg-error-subtle/40" : "border-line hover:bg-page"}`}>
                  <input type="radio" name="reset-scope" checked={scope === o.id} onChange={() => setScope(o.id)} className="mt-1 accent-[#cc392f]" />
                  <span>
                    <span className="block font-semibold">{o.title}</span>
                    <span className="block text-sm text-subtle">{o.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" checked={reimportBank} onChange={(e) => setReimportBank(e.target.checked)} className="mt-0.5" />
              <span>
                Re-import bank transactions on the next sync
                <span className="block text-subtle">Leave unticked to keep imported bank transactions gone.</span>
              </span>
            </label>
            <p className="mt-3 text-sm text-subtle">A backup is saved automatically before anything is deleted.</p>
            <label className="mt-4 block text-sm font-medium text-subtle">
              Type <strong className="font-mono text-ink">RESET</strong> to confirm
              <input
                autoFocus
                aria-label="Type RESET to confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirm === "RESET" && !busy && void reset()}
                className="mt-1 w-full rounded border border-muted/50 px-3 py-2 font-mono outline-none focus:border-error focus:ring-2 focus:ring-error/15"
              />
            </label>
            {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} disabled={busy} className="rounded px-4 py-2.5 font-semibold text-action hover:bg-pressed">
                Cancel
              </button>
              <button onClick={reset} disabled={confirm !== "RESET" || busy} className="rounded bg-error px-4 py-2.5 font-semibold text-white hover:bg-[#a62b24] disabled:opacity-40">
                {busy ? "Resetting…" : OPTIONS.find((o) => o.id === scope)!.title}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Small red button for the bottom of the left nav
export default function DevResetButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Reset (testing)"
        title="Reset (testing)"
        className="flex size-10 items-center justify-center rounded-lg text-error hover:bg-error-subtle"
      >
        <ResetIcon />
      </button>
      {open && <DevResetDialog onClose={() => setOpen(false)} />}
    </>
  );
}
