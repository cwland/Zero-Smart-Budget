import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice } from "./settingsUi";
import { setTossEnabled } from "../toss";

interface BudgetPrefs {
  fastTrack: boolean;
  tossAnimation: boolean;
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
      const saved = await api<BudgetPrefs>("PUT", "/api/settings/budget", changes);
      setPrefs(saved);
      setTossEnabled(saved.tossAnimation);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const setting = (id: string, title: string, text: string, on: boolean | undefined, change: (v: boolean) => void) => (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          <p className="mt-2 max-w-md text-subtle">{text}</p>
        </div>
        {on !== undefined && <Toggle label={title} checked={on} disabled={busy} onChange={change} />}
      </div>
    </section>
  );

  return (
    <>
      {setting("fast-track", "Fast Track", "Track new transactions directly to a suggested budget item based on past spending.", prefs?.fastTrack, (fastTrack) => update({ fastTrack }))}
      {setting("toss", "Toss animation", "When you accept a suggestion, the transaction is tossed in an arc into its budget item. Turn it off and accepted transactions move to Tracked without the animation.", prefs?.tossAnimation, (tossAnimation) => update({ tossAnimation }))}
      <Notice msg={msg} />
    </>
  );
}
