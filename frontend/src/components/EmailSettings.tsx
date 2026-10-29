import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { Card, field, primaryButton, secondaryButton } from "./settingsUi";
import { Toggle } from "./BudgetSettings";
import { Popup } from "./Popup";

type Security = "starttls" | "ssl" | "auto" | "none";

interface EmailSettingsResponse {
  source: "app" | "env" | "none";
  active: boolean;
  linksReady: boolean;
  settings: null | {
    enabled: boolean;
    host: string;
    port: number;
    security: Security;
    username: string | null;
    passwordSet: boolean;
    passwordUnreadable: boolean;
    fromName: string | null;
    fromAddress: string;
    appUrl: string | null;
  };
  env: { available: boolean; host: string | null };
  accountEmail: string | null;
}

const PRESETS: { id: string; label: string; host: string; port: number; security: Security; hint: string }[] = [
  { id: "gmail", label: "Gmail", host: "smtp.gmail.com", port: 587, security: "starttls", hint: "Username is your Gmail address. Use an app password (Google Account → Security → App passwords), not your normal password." },
  { id: "outlook", label: "Outlook / Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls", hint: "Username is your full Outlook address." },
  { id: "icloud", label: "iCloud Mail", host: "smtp.mail.me.com", port: 587, security: "starttls", hint: "Use an app-specific password from appleid.apple.com." },
  { id: "fastmail", label: "Fastmail", host: "smtp.fastmail.com", port: 465, security: "ssl", hint: "Use an app password from Fastmail settings." },
];

const SECURITY_LABELS: Record<Security, string> = {
  starttls: "STARTTLS (port 587)",
  ssl: "SSL/TLS (port 465)",
  auto: "Auto (use TLS if offered)",
  none: "None (local relay only)",
};

interface Form {
  enabled: boolean;
  host: string;
  port: string;
  security: Security;
  username: string;
  password: string; // blank = keep the saved one
  fromName: string;
  fromAddress: string;
  appUrl: string;
}

const emptyForm = (): Form => ({
  enabled: false, // off until you turn it on and fill it in
  host: "",
  port: "587",
  security: "starttls",
  username: "",
  password: "",
  fromName: "Zero Smart Budget",
  fromAddress: "",
  appUrl: window.location.origin,
});

export default function EmailSettings() {
  const [data, setData] = useState<EmailSettingsResponse | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [clearPassword, setClearPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null); // shown in the test box
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [testing, setTesting] = useState(false); // the test email popup

  async function load() {
    const d = await api<EmailSettingsResponse>("GET", "/api/settings/email");
    setData(d);
    setTestTo((t) => t || d.accountEmail || "");
    if (d.settings) {
      const s = d.settings;
      setForm({
        enabled: s.enabled,
        host: s.host,
        port: String(s.port),
        security: s.security,
        username: s.username ?? "",
        password: "",
        fromName: s.fromName ?? "",
        fromAddress: s.fromAddress,
        appUrl: s.appUrl ?? window.location.origin,
      });
    } else {
      // Nothing saved here: on only when the server's .env already provides email
      setForm({ ...emptyForm(), enabled: d.source === "env" });
    }
    setClearPassword(false);
  }

  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => ({ ...e, [k]: "" }));
  };

  // The Provider box remembers what you picked ("custom" stays custom even if the address matches a preset)
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const matched = PRESETS.find((p) => p.host === form.host);
  const providerId = providerChoice ?? matched?.id ?? "custom";
  const preset = PRESETS.find((p) => p.id === providerId);

  function body() {
    return {
      enabled: form.enabled,
      host: form.host.trim(),
      port: Number(form.port) || 587,
      security: form.security,
      username: form.username.trim() || null,
      // blank = keep saved password; clear = remove it
      ...(clearPassword ? { password: "" } : form.password ? { password: form.password } : {}),
      fromName: form.fromName.trim() || null,
      fromAddress: form.fromAddress.trim(),
      appUrl: form.appUrl.trim() || null,
    };
  }

  // Show: if the box is empty but a password is saved, load the saved one so there's something to show
  async function togglePassword() {
    if (showPassword) return setShowPassword(false);
    if (!form.password && s?.passwordSet && !s.passwordUnreadable) {
      try {
        const r = await api<{ password: string | null }>("GET", "/api/settings/email/password");
        if (r.password) set("password", r.password);
      } catch (err) {
        return showError(err);
      }
    }
    setShowPassword(true);
  }

  function showError(e: unknown) {
    if (e instanceof ApiError && e.details?.length) {
      setFieldErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
      setMsg({ ok: false, text: "Check the highlighted fields" });
    } else {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    setFieldErrors({});
    try {
      await api("PUT", "/api/settings/email", body());
      await load();
      setMsg({ ok: true, text: form.enabled ? "Saved. Email is on." : "Saved. Email is off." });
    } catch (err) {
      showError(err);
    } finally {
      setBusy("");
    }
  }

  // The on/off switch. With settings already saved it takes effect right away; otherwise turning
  // it on opens the form, and Save turns email on.
  async function toggleEmail(on: boolean) {
    setMsg(null);
    setTestMsg(null);
    setFieldErrors({});
    set("enabled", on);
    const saved = data?.settings;
    if (!saved || (on && (!saved.host || !saved.fromAddress))) {
      if (on) setMsg({ ok: true, text: "Fill in your email provider's details, send a test if you like, then Save." });
      return;
    }
    setBusy("save");
    try {
      await api("PUT", "/api/settings/email", { ...body(), enabled: on });
      await load();
      setMsg({ ok: true, text: on ? "Email is on." : "Email is off." });
    } catch (err) {
      showError(err);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setTestMsg(null);
    setFieldErrors({});
    try {
      const res = await api<{ to: string }>("POST", "/api/settings/email/test", { settings: { ...body(), enabled: true }, to: testTo.trim() || undefined });
      setTestMsg({ ok: true, text: `Test email sent to ${res.to}. Check your inbox (and spam folder).` });
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
        // The popup covers the form, so say what's wrong here too
        setTestMsg({ ok: false, text: `Fix these in the form first: ${err.details.map((d) => d.message).join(". ")}.` });
      } else setTestMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!confirmRemove) return setConfirmRemove(true);
    setConfirmRemove(false);
    setBusy("remove");
    try {
      await api("DELETE", "/api/settings/email");
      await load();
      setMsg({ ok: true, text: "Email settings removed" });
    } catch (err) {
      showError(err);
    } finally {
      setBusy("");
    }
  }

  const s = data?.settings;
  const err = (k: string) => fieldErrors[k] && <span className="mt-1 block text-sm font-normal text-error">{fieldErrors[k]}</span>;
  const errClass = (k: string) => (fieldErrors[k] ? " border-error ring-2 ring-error/15" : "");

  return (
    <div className="flex flex-col gap-6">
      <Card title="Email">
        {data && (
          <div role="status" aria-label="Email status" className="mb-5 flex flex-wrap items-center gap-2 rounded-lg bg-page px-4 py-3 text-sm">
            <span className={`rounded-full px-2.5 py-0.5 font-semibold ${data.active ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>{data.active ? "On" : "Off"}</span>
            <span className="text-subtle">
              {data.source === "app" && (data.active ? "Using the settings below." : "Email is turned off. Nothing is sent.")}
              {data.source === "env" && <>Using server settings from <code className="font-mono">.env</code> ({data.env.host}). Saving here will take over from them.</>}
              {data.source === "none" && "Not set up yet. Turn it on below to add your email provider's details."}
              {data.active && !data.linksReady && " Password reset links need the app address."}
            </span>
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold">Send email from this app</p>
            <p className="text-sm text-subtle">Password reset links and notifications (Wrap-Up reminders, nudges).</p>
          </div>
          <Toggle label="Send email from this app" checked={form.enabled} disabled={!!busy || !data} onChange={toggleEmail} />
        </div>

        {form.enabled && <form onSubmit={save} aria-label="Email settings" className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">

          <label className="text-sm font-medium text-subtle sm:col-span-2">
            Provider
            <select
              aria-label="Provider"
              value={providerId}
              onChange={(e) => {
                const id = e.target.value;
                setProviderChoice(id);
                const p = PRESETS.find((x) => x.id === id);
                if (p) setForm((f) => ({ ...f, host: p.host, port: String(p.port), security: p.security }));
                // Custom: clear a preset's address so you can type your own server
                else if (matched) setForm((f) => ({ ...f, host: "", port: "587", security: "starttls" }));
              }}
              className={field}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Other / custom server</option>
            </select>
            {preset && <span className="mt-1 block text-sm font-normal text-subtle">{preset.hint}</span>}
          </label>

          <label className="text-sm font-medium text-subtle">
            SMTP server
            <input aria-label="SMTP server" placeholder="smtp.example.com" value={form.host} onChange={(e) => set("host", e.target.value)} className={field + errClass("host")} />
            {err("host")}
          </label>
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <label className="text-sm font-medium text-subtle">
              Port
              <input aria-label="Port" inputMode="numeric" value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} className={field + errClass("port")} />
            </label>
            <label className="text-sm font-medium text-subtle">
              Security
              <select
                aria-label="Security"
                value={form.security}
                onChange={(e) => {
                  const sec = e.target.value as Security;
                  setForm((f) => ({ ...f, security: sec, port: sec === "ssl" && f.port === "587" ? "465" : sec === "starttls" && f.port === "465" ? "587" : f.port }));
                }}
                className={field}
              >
                {(Object.keys(SECURITY_LABELS) as Security[]).map((k) => (
                  <option key={k} value={k}>
                    {SECURITY_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="text-sm font-medium text-subtle">
            Username
            <input aria-label="SMTP username" autoComplete="off" placeholder="usually your email address" value={form.username} onChange={(e) => set("username", e.target.value)} className={field} />
          </label>
          <label className="text-sm font-medium text-subtle">
            Password
            <div className="relative">
              <input
                aria-label="SMTP password"
                type="text"
              style={showPassword ? undefined : { WebkitTextSecurity: "disc" } as React.CSSProperties} // dots without being a password box
                autoComplete="new-password"
                disabled={clearPassword}
                placeholder={s?.passwordSet && !clearPassword ? "Saved. Leave blank to keep it." : "App password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                className={field + " pr-16 disabled:bg-page"}
              />
              <button type="button" onClick={togglePassword} disabled={clearPassword} className="absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 px-1 text-xs font-semibold text-link disabled:text-muted">
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {s?.passwordUnreadable && <span className="mt-1 block text-sm font-normal text-error">The saved password can't be read (the server's secret changed). Enter it again.</span>}
            {s?.passwordSet && (
              <label className="mt-1 flex items-center gap-2 text-sm font-normal">
                <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> Remove saved password
              </label>
            )}
          </label>

          <label className="text-sm font-medium text-subtle">
            From name
            <input aria-label="From name" value={form.fromName} onChange={(e) => set("fromName", e.target.value)} className={field} />
          </label>
          <label className="text-sm font-medium text-subtle">
            From address
            <input aria-label="From address" type="email" placeholder="you@example.com" value={form.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} className={field + errClass("fromAddress")} />
            {err("fromAddress")}
          </label>

          <label className="text-sm font-medium text-subtle sm:col-span-2">
            App address <span className="font-normal text-muted">(used in password reset links)</span>
            <input aria-label="App address" placeholder="https://budget.example.com" value={form.appUrl} onChange={(e) => set("appUrl", e.target.value)} className={field + errClass("appUrl")} />
            {err("appUrl")}
            {form.appUrl.trim() !== window.location.origin && (
              <button type="button" onClick={() => set("appUrl", window.location.origin)} className="mt-1 text-sm font-semibold text-link hover:underline">
                Use this page's address ({window.location.origin})
              </button>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4 sm:col-span-2">
            <button type="submit" disabled={!!busy} className={primaryButton}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {s && (
              <button
                type="button"
                onClick={remove}
                onBlur={() => setConfirmRemove(false)}
                disabled={!!busy}
                className={`rounded px-3 py-2.5 text-sm font-semibold ${confirmRemove ? "bg-error text-white" : "text-error hover:bg-error-subtle"}`}
              >
                {confirmRemove ? "Remove all email settings?" : "Remove settings"}
              </button>
            )}
            <button type="button" onClick={() => (setTestMsg(null), setTesting(true))} disabled={!!busy} className={secondaryButton + " ml-auto"}>
              Send test email
            </button>
          </div>
        </form>}

        {testing && (
          <Popup title="Send a test email" onClose={() => setTesting(false)}>
            <div className="flex flex-col gap-4 p-6">
              <p className="text-sm text-subtle">Uses the settings in the form, even before you save, so you can check them first.</p>
              <label className="text-sm font-medium text-subtle">
                Send to
                <input aria-label="Send test to" type="email" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} className={field} />
              </label>
              {testMsg && (
                <p role={testMsg.ok ? "status" : "alert"} className={`rounded-lg px-4 py-3 text-sm ${testMsg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>
                  {testMsg.text}
                </p>
              )}
              <p className="text-sm text-subtle">
                With email on, an app address, and an email on <a href="#/settings/profile" className="font-semibold text-link hover:underline">your profile</a>, the sign-in page shows <strong>Forgot password?</strong>
              </p>
              <div className="flex justify-end gap-3 border-t border-line pt-4">
                <button type="button" onClick={() => setTesting(false)} className="px-3 py-2.5 font-semibold text-subtle hover:underline">
                  Close
                </button>
                <button type="button" onClick={test} disabled={!!busy} className={primaryButton}>
                  {busy === "test" ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </Popup>
        )}

        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`mt-4 rounded-lg px-4 py-3 text-sm ${msg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>
            {msg.text}
          </p>
        )}
        <p className="mt-4 border-t border-line pt-3 text-sm text-subtle">
          Emails sent in the last 30 days are in{" "}
          <a href="#/settings/logs?type=email" className="font-semibold text-link hover:underline">
            Settings › Logs
          </a>
          .
        </p>
      </Card>

      <Card title="Locked out without email?">
        <p className="text-subtle">Reset the password from the server itself:</p>
        <pre className="mt-3 overflow-x-auto rounded bg-ink p-3 font-mono text-xs leading-relaxed text-white">{`cd backend && npm run reset-password

# with Docker
docker compose exec api npm run reset-password`}</pre>
      </Card>
    </div>
  );
}
