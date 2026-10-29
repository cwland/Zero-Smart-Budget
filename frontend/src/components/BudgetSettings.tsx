import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Notice } from "./settingsUi";
import { setTossEnabled } from "../toss";

interface BudgetPrefs {
  fastTrack: boolean;
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
  services: { name: string; provider: string; enabled: boolean }[];
}

// An on/off switch with its label
export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
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
      <span className="w-7 text-lg">{checked ? "On" : "Off"}</span>
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

interface NotifyPrefs {
  enabled: boolean;
  monthCloseReminder: boolean;
  nudge: boolean;
  nudgeDays: number;
  monthlySummary: boolean;
}

// Email notifications
function NotificationSettings({ monthCloseOn }: { monthCloseOn: boolean }) {
  const [data, setData] = useState<{ settings: NotifyPrefs; emailReady: boolean; to: string | null } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("7");
  useEffect(() => {
    api<{ settings: NotifyPrefs; emailReady: boolean; to: string | null }>("GET", "/api/settings/notifications")
      .then((d) => {
        setData(d);
        setDays(String(d.settings.nudgeDays));
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);
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
  const update = (changes: Partial<NotifyPrefs>) => run(async () => setData(await api("PUT", "/api/settings/notifications", changes)));
  const test = () =>
    run(async () => {
      const r = await api<{ to: string }>("POST", "/api/settings/notifications/test");
      setMsg({ ok: true, text: `Test email sent to ${r.to}` });
    });
  const ready = !!data?.emailReady && !!data?.to;
  const s = data?.settings;
  const on = !!s?.enabled && ready;
  const check = (label: string, sub: ReactNode, checked: boolean, change: (v: boolean) => void, disabled = false, extra?: ReactNode) => (
    <div className="flex items-start gap-3">
      <input type="checkbox" aria-label={label} checked={checked} disabled={busy || disabled} onChange={(e) => change(e.target.checked)} className="mt-1 size-4" />
      <div className="min-w-0 flex-1">
        <div className={`font-semibold ${disabled ? "text-muted" : ""}`}>{label}</div>
        <div className="text-sm text-subtle">{sub}</div>
        {extra}
      </div>
    </div>
  );
  return (
    <SettingCard
      title="Notifications"
      text={
        !data ? (
          "Emails about your budget."
        ) : !data.emailReady ? (
          <>
            Set up email first in{" "}
            <a href="#/settings/email" className="font-semibold text-link hover:underline">
              Settings › Email
            </a>
            , then turn these on here.
          </>
        ) : !data.to ? (
          <>
            Add your email address in{" "}
            <a href="#/settings/profile" className="font-semibold text-link hover:underline">
              Settings › Profile
            </a>{" "}
            so there's somewhere to send them.
          </>
        ) : (
          `Emails about your budget, sent to ${data.to}.`
        )
      }
      toggle={data && <Toggle label="Notifications" checked={on} disabled={busy || !ready} onChange={(enabled) => update({ enabled })} />}
    >
      {on && s && (
        <div className="flex flex-col gap-4">
          {check(
            "Time to wrap up the month",
            monthCloseOn ? "An email when the Wrap Up button shows up, once a month." : "Month Wrap-Up is turned off above.",
            s.monthCloseReminder,
            (monthCloseReminder) => update({ monthCloseReminder }),
            !monthCloseOn
          )}
          {check(
            "Nudge me when transactions are waiting",
            "If you haven't opened the app in a while and some transactions have no budget item yet.",
            s.nudge,
            (nudge) => update({ nudge }),
            false,
            s.nudge && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                After
                <input
                  aria-label="Days away before a nudge"
                  type="number"
                  min={1}
                  max={90}
                  value={days}
                  disabled={busy}
                  onChange={(e) => setDays(e.target.value)}
                  onBlur={() => Number(days) !== s.nudgeDays && Number(days) >= 1 && update({ nudgeDays: Math.min(90, Math.round(Number(days))) })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="w-16 rounded border border-muted/50 px-2 py-1 text-center"
                />
                days away
              </label>
            )
          )}
          {check("Monthly summary", "A recap of last month's spending. Coming with Reports.", false, () => {}, true)}
          <div>
            <button type="button" onClick={test} disabled={busy} className="rounded border border-primary px-4 py-2 text-sm font-semibold text-primary hover:bg-pressed disabled:opacity-60">
              Send a test email
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-error"}`}>
          {msg.text}
        </p>
      )}
    </SettingCard>
  );
}

const select = "rounded border border-muted/50 bg-white px-3 py-2 outline-none focus:border-action focus:ring-2 focus:ring-action/15";

export default function BudgetSettings() {
  const [prefs, setPrefs] = useState<BudgetPrefs | null>(null);
  const [ai, setAi] = useState<AiUsage | null | undefined>(undefined); // null: AI not set up at all
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAiInfo, setShowAiInfo] = useState(false);

  useEffect(() => {
    api<BudgetPrefs>("GET", "/api/settings/budget")
      .then(setPrefs)
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    api<{ settings: AiUsage | null }>("GET", "/api/settings/ai")
      .then((r) => setAi(r.settings))
      .catch(() => setAi(null));
  }, []);

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

  const aiReady = !!ai?.ready;
  const aiOn = !!ai?.enabled && aiReady;

  return (
    <>
      <SettingCard
        title="Quick Assign"
        text="Use the budget items you picked for a merchant before to suggest one for each new transaction."
        toggle={prefs && <Toggle label="Quick Assign" checked={prefs.fastTrack} disabled={busy} onChange={(fastTrack) => update({ fastTrack })} />}
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
          aiReady ? (
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

      {prefs && <NotificationSettings monthCloseOn={prefs.monthCloseEnabled} />}

      <SettingCard
        title="Toss animation"
        text="When you accept a suggestion, the transaction is tossed in an arc into its budget item. Turn it off and accepted transactions move to Assigned without the animation."
        toggle={prefs && <Toggle label="Toss animation" checked={prefs.tossAnimation} disabled={busy} onChange={(tossAnimation) => update({ tossAnimation })} />}
      />
      <Notice msg={msg} />
    </>
  );
}
