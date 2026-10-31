import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { centsToInput, parseMoney } from "../money";
import { SettingCard, Toggle } from "./BudgetSettings";
import EmailPreview from "./EmailPreview";
import { canManage, useSession } from "../session";

// Settings › Notifications: every email the app can send, each with its own switch,
// Preview (see it without sending) and Send a sample (to you, marked [Test]).

export interface NotifyPrefs {
  enabled: boolean;
  monthCloseReminder: boolean;
  nudge: boolean;
  nudgeDays: number;
  monthlySummary: boolean;
  monthlySummaryAi: boolean;
  monthlyInsights: boolean;
  bankAttention: boolean;
  overBudget: boolean;
  weekly: boolean;
  weeklyDay: number;
  goalMilestones: boolean;
  largePurchase: boolean;
  largePurchaseCents: number;
  nextMonth: boolean;
  nextMonthDays: number;
  newSignIn: boolean;
}
type Status = { settings: NotifyPrefs; emailReady: boolean; to: string | null };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const small = "rounded border border-muted/50 bg-white px-2 py-1 text-sm outline-none focus:border-action focus:ring-2 focus:ring-action/15";

// A number box that saves when you leave it
function NumberField({ label, value, min, max, onSave, disabled, money }: { label: string; value: number; min: number; max: number; onSave: (v: number) => void; disabled?: boolean; money?: boolean }) {
  const show = (v: number) => (money ? centsToInput(v) : String(v));
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const v = money ? parseMoney(text) : Math.round(Number(text));
    if (v === null || Number.isNaN(v) || v < min || v > max) return setText(show(value));
    if (v !== value) onSave(v);
  };
  return (
    <span className="inline-flex items-center gap-1">
      {money && "$"}
      <input aria-label={label} inputMode={money ? "decimal" : "numeric"} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className={`${small} ${money ? "w-24" : "w-14 text-center"}`} />
    </span>
  );
}

export default function NotificationSettings() {
  const manage = canManage(useSession().user);
  const [data, setData] = useState<Status | null>(null);
  const [monthCloseOn, setMonthCloseOn] = useState(true);
  const [aiReady, setAiReady] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ kind: string; title: string } | null>(null);

  useEffect(() => {
    api<Status>("GET", "/api/settings/notifications")
      .then(setData)
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    api<{ monthCloseEnabled: boolean }>("GET", "/api/settings/budget")
      .then((b) => setMonthCloseOn(b.monthCloseEnabled))
      .catch(() => {});
    if (manage)
      api<{ settings: { enabled: boolean; ready: boolean; available: boolean } | null }>("GET", "/api/settings/ai")
        .then((r) => setAiReady(!!r.settings?.enabled && !!r.settings?.ready && r.settings?.available !== false))
        .catch(() => {});
    // A "user" can't see the AI settings: just whether AI is on
    else
      api<{ enabled: boolean }>("GET", "/api/ai/status")
        .then((r) => setAiReady(r.enabled))
        .catch(() => {});
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
  const update = (changes: Partial<NotifyPrefs>) => run(async () => setData(await api<Status>("PUT", "/api/settings/notifications", changes)));
  // Send a sample: shown on its own row ("Sending…", then the result), without locking the page
  const [sending, setSending] = useState<string | null>(null);
  const [sampleMsg, setSampleMsg] = useState<{ kind: string; ok: boolean; text: string } | null>(null);
  const sample = async (kind: string) => {
    setSending(kind);
    setSampleMsg(null);
    try {
      const r = await api<{ to: string; subject: string }>("POST", "/api/settings/notifications/test", { kind });
      setSampleMsg({ kind, ok: true, text: `Sent "${r.subject}" to ${r.to}. It can take a minute to arrive.` });
    } catch (e) {
      setSampleMsg({ kind, ok: false, text: (e as Error).message });
    } finally {
      setSending(null);
    }
  };

  const ready = !!data?.emailReady && !!data?.to;
  const s = data?.settings;
  const on = !!s?.enabled && ready;

  // One notification: switch, what it is, its options, and Preview / Send a sample
  const row = (o: { title: string; text: ReactNode; checked: boolean; set: (v: boolean) => void; kind: string; options?: ReactNode; disabledNote?: string }) => (
    <li className="flex items-start gap-4 py-4">
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${o.disabledNote ? "text-muted" : ""}`}>{o.title}</p>
        <p className="text-sm text-subtle">{o.disabledNote ?? o.text}</p>
        {o.checked && !o.disabledNote && o.options && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">{o.options}</div>}
        <div className="mt-1.5 flex gap-4 text-sm">
          <button type="button" onClick={() => setPreview({ kind: o.kind, title: o.title })} className="font-semibold text-link hover:underline">
            Preview
          </button>
          {ready && (
            <button type="button" onClick={() => sample(o.kind)} disabled={sending !== null} className="font-semibold text-link hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60">
              {sending === o.kind ? "Sending…" : "Send a sample"}
            </button>
          )}
        </div>
        {sampleMsg?.kind === o.kind && (
          <p role={sampleMsg.ok ? "status" : "alert"} className={`mt-1.5 text-sm ${sampleMsg.ok ? "text-success" : "text-error"}`}>
            {sampleMsg.ok ? "✓ " : ""}
            {sampleMsg.text}
          </p>
        )}
      </div>
      <Toggle label={o.title} checked={o.checked && !o.disabledNote} disabled={!!o.disabledNote} onChange={o.set} text="" />
    </li>
  );
  const section = (title: string, rows: ReactNode) => (
    <section aria-label={title} className="rounded-2xl bg-white px-6 pb-2 pt-5">
      <h2 className="text-lg font-bold">{title}</h2>
      <ul className="divide-y divide-line">{rows}</ul>
    </section>
  );

  return (
    <>
      <SettingCard
        title="Email notifications"
        text={
          !data ? (
            "Emails about your budget."
          ) : !data.emailReady && !manage ? (
            "Email isn't set up on this server yet, so nothing can be sent. Ask the account owner to set it up. You can still preview each email below."
          ) : !data.emailReady ? (
            <>
              Turn on and set up email first in{" "}
              <a href="#/settings/email" className="font-semibold text-link hover:underline">
                Settings › Email
              </a>
              . You can still preview each email below.
            </>
          ) : !data.to ? (
            <>
              Add your email address in{" "}
              <a href="#/settings/profile" className="font-semibold text-link hover:underline">
                Settings › Profile
              </a>{" "}
              so there's somewhere to send them.
            </>
          ) : on ? (
            `Sent to ${data.to}, in your theme's colors. Samples use your real numbers where there are some, and their subject starts with [Test].`
          ) : (
            `Off: nothing is sent. Turn this on to get the ones switched on below at ${data.to}.`
          )
        }
        toggle={<Toggle label="Email notifications" checked={data ? on : null} disabled={busy || !ready} onChange={(enabled) => update({ enabled })} />}
      >
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-error"}`}>
            {msg.text}
          </p>
        )}
      </SettingCard>

      {s && (
        <div className={`flex flex-col gap-6 ${on ? "" : "opacity-80"}`}>
          {section(
            "Your budget",
            <>
              {row({ title: "Time to wrap up the month", text: "When the Wrap Up button shows up, once a month, with the month's planned, spent and left.", checked: s.monthCloseReminder, set: (v) => update({ monthCloseReminder: v }), kind: "month-close", disabledNote: monthCloseOn ? undefined : "Month Wrap-Up is turned off in Settings › Budget." })}
              {row({ title: "Over budget", text: "When an item spends more than planned this month. Once per item per month; items linked to a fund are left out.", checked: s.overBudget, set: (v) => update({ overBudget: v }), kind: "over-budget" })}
              {row({
                title: "Next month isn't set up",
                text: "A reminder before a new month starts, if there's no budget for it yet.",
                checked: s.nextMonth,
                set: (v) => update({ nextMonth: v }),
                kind: "next-month",
                options: (
                  <>
                    <NumberField label="Days before the month starts" value={s.nextMonthDays} min={1} max={14} disabled={busy} onSave={(nextMonthDays) => update({ nextMonthDays })} /> days before it starts
                  </>
                ),
              })}
              {row({
                title: "Transactions are waiting",
                text: "If you haven't opened the app in a while and some transactions have no budget item yet. Lists a few of them.",
                checked: s.nudge,
                set: (v) => update({ nudge: v }),
                kind: "nudge",
                options: (
                  <>
                    After <NumberField label="Days away before a nudge" value={s.nudgeDays} min={1} max={90} disabled={busy} onSave={(nudgeDays) => update({ nudgeDays })} /> days away
                  </>
                ),
              })}
            </>
          )}

          {section(
            "Summaries",
            <>
              {row({
                title: "Weekly check-in",
                text: "What you spent this week, what's left this month, items almost used up or over, and transactions waiting.",
                checked: s.weekly,
                set: (v) => update({ weekly: v }),
                kind: "weekly",
                options: (
                  <>
                    Every
                    <select aria-label="Weekly check-in day" value={s.weeklyDay} disabled={busy} onChange={(e) => update({ weeklyDay: Number(e.target.value) })} className={small}>
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                    morning
                  </>
                ),
              })}
              {row({
                title: "Monthly summary",
                text: "On the 1st: last month's income, spending, savings rate, where it went and anything unusual.",
                checked: s.monthlySummary,
                set: (v) => update({ monthlySummary: v }),
                kind: "summary",
                options: (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={s.monthlySummaryAi} disabled={busy} onChange={(e) => update({ monthlySummaryAi: e.target.checked })} className="size-4 accent-action" />
                    Add a few lines from AI {aiReady ? "" : <span className="text-muted">(when AI is on in Settings › AI)</span>}
                  </label>
                ),
              })}
              {row({
                title: "Monthly insights",
                text: (
                  <>
                    On the 2nd: spending that keeps rising, plans that keep missing (with a better amount), subscriptions that went up or just started, your wins, and one focus for next month.{" "}
                    {aiReady ? "AI writes the wording; the numbers come from your budget." : <span className="text-muted">Works without AI; with AI on in Settings › AI it also writes a short intro and the focus.</span>}
                  </>
                ),
                checked: s.monthlyInsights,
                set: (v) => update({ monthlyInsights: v }),
                kind: "insights",
              })}
            </>
          )}

          {section(
            "Goals and spending",
            <>
              {row({ title: "Goal milestones", text: "When a goal reaches 25%, 50%, 75% and 100%, or a fund reaches its target. Also if a goal with a date falls behind (at most once a month).", checked: s.goalMilestones, set: (v) => update({ goalMilestones: v }), kind: "goal" })}
              {row({
                title: "Large purchase",
                text: "Right after a single purchase over the amount you pick comes in.",
                checked: s.largePurchase,
                set: (v) => update({ largePurchase: v }),
                kind: "large-purchase",
                options: (
                  <>
                    Over <NumberField label="Large purchase amount" money value={s.largePurchaseCents} min={100} max={100_000_000} disabled={busy} onSave={(largePurchaseCents) => update({ largePurchaseCents })} />
                  </>
                ),
              })}
            </>
          )}

          {section(
            "Accounts and security",
            <>
              {row({ title: "Bank needs attention", text: "When a bank connection needs you to sign in again or stops updating, so transactions don't quietly stop coming in.", checked: s.bankAttention, set: (v) => update({ bankAttention: v }), kind: "bank" })}
              {row({ title: "New sign-in", text: "Right away, when a browser or device signs in to your account for the first time.", checked: s.newSignIn, set: (v) => update({ newSignIn: v }), kind: "sign-in" })}
            </>
          )}
          <p className="px-1 text-xs text-muted">Morning emails go out after 8am, server time. The server checks once an hour.</p>
        </div>
      )}
      {preview && <EmailPreview kind={preview.kind} title={preview.title} onClose={() => setPreview(null)} />}
    </>
  );
}
