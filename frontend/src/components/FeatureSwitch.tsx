import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Toggle } from "./BudgetSettings";
import { Notice } from "./settingsUi";

export type Feature = "plaid" | "ai" | "apiKeys";
export type Features = Record<Feature, boolean>;

// The master switch at the top of Settings > Plaid, AI and API keys. Off hides that tab's
// settings (and the server stops using the feature); everything saved is kept for when it's back on.
// The switch saves right away.
export function FeatureSwitch({ feature, title, text, offText, children }: { feature: Feature; title: string; text: ReactNode; offText: ReactNode; children: ReactNode }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Features>("GET", "/api/settings/features")
      .then((f) => setOn(f[feature]))
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, [feature]);

  async function toggle(value: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const f = await api<Features>("PUT", "/api/settings/features", { [feature]: value });
      setOn(f[feature]);
      window.dispatchEvent(new CustomEvent("features-changed", { detail: f }));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section aria-label={title} className="rounded-2xl bg-white p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 max-w-xl text-subtle">{on === false ? offText : text}</p>
          </div>
          <Toggle label={title} checked={!!on} disabled={busy || on === null} onChange={toggle} />
        </div>
        {msg && (
          <div className="mt-4">
            <Notice msg={msg} />
          </div>
        )}
      </section>
      {on && children}
    </>
  );
}
