import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice } from "./settingsUi";

interface BudgetPrefs {
  fastTrack: boolean;
}

// An EveryDollar-style on/off switch with its label
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 rounded-full transition disabled:opacity-60 ${checked ? "bg-action" : "bg-strong"}`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-6" : "left-1"}`} />
      </button>
      <span className="w-7 text-lg">{checked ? "On" : "Off"}</span>
    </label>
  );
}

export default function BudgetSettings() {
  const [prefs, setPrefs] = useState<BudgetPrefs | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<BudgetPrefs>("GET", "/api/settings/budget")
      .then(setPrefs)
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  async function update(changes: Partial<BudgetPrefs>) {
    setMsg(null);
    setBusy(true);
    try {
      setPrefs(await api<BudgetPrefs>("PUT", "/api/settings/budget", changes));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Fast Track" className="rounded-2xl bg-white p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-xl font-bold">Fast Track</h2>
          <p className="mt-2 max-w-md text-subtle">Track new transactions directly to a suggested budget item based on past spending.</p>
        </div>
        {prefs && <Toggle label="Fast Track" checked={prefs.fastTrack} disabled={busy} onChange={(fastTrack) => update({ fastTrack })} />}
      </div>
      <div className="mt-2">
        <Notice msg={msg} />
      </div>
    </section>
  );
}
