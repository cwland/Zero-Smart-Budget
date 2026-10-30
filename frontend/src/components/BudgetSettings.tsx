import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Notice } from "./settingsUi";
import { setTossEnabled } from "../toss";
import { canManage, useSession } from "../session";

interface BudgetPrefs {
  quickAssign: boolean;
  tossAnimation: boolean;
  monthCloseDays: number;
  monthCloseEnabled: boolean;
  monthCloseAuto: boolean;
}

// How AI suggestions are used (the services themselves are set up in Settings > AI)
interface AiUsage {
  enabled: boolean;
  mode: "auto" | "manual";
  askNextOnNoMatch: boolean;
  ready: boolean; // at least one service is set up and on
  available: boolean; // Settings > AI's master switch
  services: { name: string; provider: string; enabled: boolean }[];
}

// An on/off switch with its label
// text: what shows beside the switch (default "On"/"Off")
export function Toggle({ label, checked, disabled, onChange, text }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; text?: ReactNode }) {
  return (
    <label className={`flex shrink-0 items-center gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 rounded-full transition disabled:opacity-50 ${checked ? "bg-action" : "bg-strong"}`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-6" : "left-1"}`} />
      </button>
      {text ?? <span className="w-7 text-lg">{checked ? "On" : "Off"}</span>}
    </label>
  );
}

// A settings card: title, explanation, a switch on the right, and options underneath when it's on
export function SettingCard({ title, text, toggle, children, titleExtra }: { title: string; text: ReactNode; toggle?: ReactNode; children?: ReactNode; titleExtra?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            {title}
            {titleExtra}
          </h2>
          <div className="mt-2 max-w-md text-subtle">{text}</div>
        </div>
        {toggle}
      </div>
      {children && <div className="mt-5 border-t border-line pt-5">{children}</div>}
    </section>
  );
}

// What AI categorization sends, shown from the ⓘ button
function AiPrivacyInfo({ services }: { services: { name: string; provider: string; enabled: boolean }[] }) {
  const on = services.filter((s) => s.enabled);
  return (
    <div role="note" aria-label="What is sent to the AI" className="mb-5 rounded-xl bg-page p-4 text-sm">
      <h3 className="font-semibold">What's sent to the AI</h3>
      <p className="mt-1 text-subtle">Only for transactions with no history to learn from (merchants you've categorized before are never sent). For each one:</p>
      <ul className="mt-2 list-disc pl-5">
        <li>Merchant name, amount and date</li>
        <li>Whether it's money in or money out</li>
        <li>The account's name and type (like "Plaid Checking (checking)"), if it has one</li>
        <li>Your note on the transaction, if any</li>
        <li>That month's budget item and group names, so the AI can pick one</li>
      </ul>
      <h3 className="mt-3 font-semibold">Never sent</h3>
      <ul className="mt-1 list-disc pl-5 text-subtle">
        <li>Account numbers, balances or bank logins</li>
        <li>Your name, email, passwords or API keys</li>
        <li>Planned amounts, other transactions, funds or goals</li>
      </ul>
      {on.length > 0 && (
        <p className="mt-3 text-subtle">
          Sent to: {on.map((s) => `${s.name} (${s.provider === "local" ? "on your own network" : "an outside service"})`).join(", then ")}. Nothing is assigned until you accept a suggestion.
        </p>
      )}
    </div>
  );
}

const select = "rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";

export default function BudgetSettings() {
  const [prefs, setPrefs] = useState<BudgetPrefs | null>(null);
  const [ai, setAi] = useState<AiUsage | null | undefined>(undefined); // null: AI not set up at all
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAiInfo, setShowAiInfo] = useState(false);
  const { user } = useSession();
  const manage = canManage(user);

  useEffect(() => {
    api<BudgetPrefs>("GET", "/api/settings/budget")
      .then(setPrefs)
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    if (manage)
      api<{ settings: AiUsage | null }>("GET", "/api/settings/ai")
        .then((r) => setAi(r.settings))
        .catch(() => setAi(null));
  }, [manage]);

  async function run(fn: () => Promise<void>) {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const update = (changes: Partial<BudgetPrefs>) =>
    run(async () => {
      const saved = await api<BudgetPrefs>("PUT", "/api/settings/budget", changes);
      setPrefs(saved);
      setTossEnabled(saved.tossAnimation);
    });
  const updateAi = (changes: Partial<Pick<AiUsage, "enabled" | "mode" | "askNextOnNoMatch">>) =>
    run(async () => setAi((await api<{ settings: AiUsage }>("PUT", "/api/settings/ai/usage", changes)).settings));

  const aiOff = !!ai && !ai.available; // Settings > AI switched off: greyed out here
  const aiReady = !!ai?.ready && !aiOff;
  const aiOn = !!ai?.enabled && aiReady;

  // A "user" (shared access) only has their own toss animation here; the rest is the owner's setup
  const toss = (
    <SettingCard
      title="Toss animation"
      text={`When you accept a suggestion, the transaction is tossed in an arc into its budget item. Turn it off and accepted transactions move to Assigned without the animation.${manage ? " This is just for you; everyone you share the budget with has their own." : ""}`}
      toggle={prefs && <Toggle label="Toss animation" checked={prefs.tossAnimation} disabled={busy} onChange={(tossAnimation) => update({ tossAnimation })} />}
    />
  );
  if (!manage)
    return (
      <>
        {toss}
        <p className="px-1 text-sm text-subtle">Quick Assign, AI categorization and Month Wrap-Up are set by the account owner.</p>
        <Notice msg={msg} />
      </>
    );

  return (
    <>
      <SettingCard
        title="Quick Assign"
        text="Use the budget items you picked for a merchant before to suggest one for each new transaction."
        toggle={prefs && <Toggle label="Quick Assign" checked={prefs.quickAssign} disabled={busy} onChange={(quickAssign) => update({ quickAssign })} />}
      />

      <SettingCard
        title="AI categorization"
        titleExtra={
          <button
            type="button"
            onClick={() => setShowAiInfo((v) => !v)}
            aria-label="What is sent to the AI"
            aria-expanded={showAiInfo}
            title="What is sent to the AI"
            className={`flex size-6 items-center justify-center rounded-full border text-sm font-bold ${showAiInfo ? "border-action bg-action text-white" : "border-strong text-subtle hover:border-action hover:text-action"}`}
          >
            i
          </button>
        }
        text={
          aiOff ? (
            <>
              AI is turned off. Turn it on in{" "}
              <a href="#/settings/ai" className="font-semibold text-link hover:underline">
                Settings › AI
              </a>{" "}
              to use it here.
            </>
          ) : aiReady ? (
            "When a transaction has no history to learn from, AI suggests a budget item. Nothing is assigned until you accept it."
          ) : (
            <>
              Set up an AI service first in{" "}
              <a href="#/settings/ai" className="font-semibold text-link hover:underline">
                Settings › AI
              </a>
              , then turn it on here.
            </>
          )
        }
        toggle={ai !== undefined && <Toggle label="AI categorization" checked={aiOn} disabled={busy || !aiReady} onChange={(enabled) => updateAi({ enabled })} />}
      >
        {showAiInfo && <AiPrivacyInfo services={ai?.services ?? []} />}
        {aiOn && ai && (
          <div className="flex flex-col gap-4">
            <fieldset>
              <legend className="font-semibold">How to use it</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["auto", "Automatically", "After each bank update and when you add a transaction"],
                    ["manual", "Only when I ask", "Nothing is sent until you click Ask AI"],
                  ] as const
                ).map(([id, label, hint]) => (
                  <label key={id} className={`cursor-pointer rounded-lg border p-3 ${ai.mode === id ? "border-action bg-pressed" : "border-line hover:bg-page"}`}>
                    <span className="flex items-center gap-2 font-semibold">
                      <input type="radio" name="ai-mode" checked={ai.mode === id} disabled={busy} onChange={() => updateAi({ mode: id })} />
                      {label}
                    </span>
                    <span className="mt-1 block text-sm text-subtle">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </SettingCard>

      <SettingCard
        title="Month Wrap-Up"
        text="When a month ends, see where you came out ahead or went over, then decide where any extra money goes (or what covers a shortfall). A wrapped-up month's plan is locked until you reopen it."
        toggle={prefs && <Toggle label="Month Wrap-Up" checked={prefs.monthCloseEnabled} disabled={busy} onChange={(monthCloseEnabled) => update({ monthCloseEnabled })} />}
      >
        {prefs?.monthCloseEnabled ? (
          <div className="flex flex-col gap-5">
          <label className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <span className="block font-semibold">Show the Wrap Up button</span>
              <span className="block text-sm text-subtle">Past months that aren't wrapped up always show it.</span>
            </span>
            <select aria-label="Show Wrap Up" value={prefs.monthCloseDays} disabled={busy} onChange={(e) => update({ monthCloseDays: Number(e.target.value) })} className={select}>
              <option value={0}>On the last day</option>
              {Array.from({ length: 14 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? "" : "s"} before{d === 4 ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="font-semibold">Months you don't wrap up yourself</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(
                [
                  [true, "Wrap them up for me", "Two months later (September on November 1). Anything left over stays in that month."],
                  [false, "Leave them open", "They stay open and editable until you wrap them up yourself."],
                ] as const
              ).map(([auto, label, hint]) => (
                <label key={label} className={`cursor-pointer rounded-lg border p-3 ${prefs.monthCloseAuto === auto ? "border-action bg-pressed" : "border-line hover:bg-page"}`}>
                  <span className="flex items-center gap-2 font-semibold">
                    <input type="radio" name="month-close-auto" checked={prefs.monthCloseAuto === auto} disabled={busy} onChange={() => update({ monthCloseAuto: auto })} />
                    {label}
                  </span>
                  <span className="mt-1 block text-sm text-subtle">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          </div>
        ) : prefs ? (
          <p className="text-sm text-subtle">Off: no Wrap Up button, and months never wrap up on their own. Months already wrapped up stay that way until you reopen them.</p>
        ) : null}
      </SettingCard>


      {toss}
      <Notice msg={msg} />
    </>
  );
}
