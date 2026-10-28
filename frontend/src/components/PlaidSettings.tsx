import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { Card, Notice, field, primaryButton, secondaryButton } from "./settingsUi";
import { EyeIcon, EyeOffIcon } from "./Icons";

type Env = "sandbox" | "production";

interface Summary {
  clientId: string;
  env: Env;
  sandboxSecretSet: boolean;
  productionSecretSet: boolean;
  sandboxSecret: string | null;
  productionSecret: string | null;
  unreadable: boolean;
}

const ENV_INFO: Record<Env, { label: string; hint: string }> = {
  sandbox: { label: "Sandbox", hint: "Fake banks and test data. Use this to try things out." },
  production: { label: "Production (Trial plan)", hint: "Your real banks. The free Trial plan allows up to 10 bank connections." },
};

export default function PlaidSettings() {
  const [saved, setSaved] = useState<Summary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clientId, setClientId] = useState("");
  const [env, setEnv] = useState<Env>("sandbox");
  const [sandboxSecret, setSandboxSecret] = useState(""); // what's in the box (the saved secret, or a new one)
  const [productionSecret, setProductionSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  function apply(s: Summary | null) {
    setSaved(s);
    setClientId(s?.clientId ?? "");
    setEnv(s?.env ?? "sandbox");
    setSandboxSecret(s?.sandboxSecret ?? "");
    setProductionSecret(s?.productionSecret ?? "");
    setShowSecret(false);
  }

  useEffect(() => {
    api<{ settings: Summary | null }>("GET", "/api/settings/plaid")
      .then((r) => apply(r.settings))
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }))
      .finally(() => setLoaded(true));
  }, []);

  // The boxes hold the real secrets, so send them as they are (an emptied box removes that secret)
  const body = () => ({
    clientId: clientId.trim(),
    env,
    sandboxSecret: sandboxSecret.trim(),
    productionSecret: productionSecret.trim(),
  });

  async function run(kind: "save" | "test" | "remove", fn: () => Promise<void>) {
    setMsg(null);
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("save", async () => {
      const r = await api<{ settings: Summary }>("PUT", "/api/settings/plaid", body());
      apply(r.settings);
      setMsg({ ok: true, text: "Saved" });
    });
  };

  const test = () =>
    run("test", async () => {
      if (!clientId.trim()) throw new Error("Enter your client ID first");
      const r = await api<{ message: string }>("POST", "/api/settings/plaid/test", body());
      setMsg({ ok: true, text: r.message });
    });

  const remove = () =>
    run("remove", async () => {
      await api("DELETE", "/api/settings/plaid");
      apply(null);
      setConfirmRemove(false);
      setMsg({ ok: true, text: "Plaid keys removed" });
    });

  // Masked secret with an eye button to show/hide it
  const secretInput = (which: Env, value: string, set: (v: string) => void) => {
    const label = which === "sandbox" ? "Sandbox secret" : "Production secret";
    return (
      <label className="block text-sm font-medium text-subtle">
        {label}
        <span className="relative mt-1 block">
          <input
            aria-label={label}
            type="text"
              style={showSecret ? undefined : { WebkitTextSecurity: "disc" } as React.CSSProperties} // dots without being a password box
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the secret from Plaid"
            value={value}
            onChange={(e) => set(e.target.value)}
            className={field + " !mt-0 pr-11 font-mono"}
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            aria-label={showSecret ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={showSecret}
            title={showSecret ? "Hide" : "Show"}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r text-subtle hover:text-ink"
          >
            {showSecret ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
      </label>
    );
  };

  if (!loaded) return null;

  return (
    <Card
      title="Plaid keys"
      description={
        <>
          Plaid imports transactions from your banks. Copy your keys from{" "}
          <a href="https://dashboard.plaid.com/developers/keys" target="_blank" rel="noreferrer" className="text-action hover:underline">
            Plaid dashboard → Developers → Keys
          </a>
          . Secrets are stored encrypted; use the eye to show one.
        </>
      }
    >
      {saved?.unreadable && (
        <p role="alert" className="mb-4 rounded bg-error-subtle px-3 py-2 text-error">
          A saved secret can't be read (the server's JWT_SECRET changed). Paste it again and save.
        </p>
      )}
      <form onSubmit={save} className="flex flex-col gap-4">
        <fieldset>
          <legend className="text-sm font-medium text-subtle">Environment</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(Object.keys(ENV_INFO) as Env[]).map((id) => (
              <label key={id} className={`cursor-pointer rounded-lg border p-3 ${env === id ? "border-action bg-pressed" : "border-line hover:bg-page"}`}>
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="plaid-env" value={id} checked={env === id} onChange={() => setEnv(id)} />
                  {ENV_INFO[id].label}
                </span>
                <span className="mt-1 block text-sm text-subtle">{ENV_INFO[id].hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="text-sm font-medium text-subtle">
          Client ID
          <input aria-label="Client ID" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} className={field} required />
        </label>
        {/* Only the secret for the environment picked above; the other one stays saved */}
        <div>
          {env === "sandbox"
            ? secretInput("sandbox", sandboxSecret, setSandboxSecret)
            : secretInput("production", productionSecret, setProductionSecret)}
          <p className="mt-1.5 text-sm text-subtle">
            {env === "sandbox"
              ? saved?.productionSecretSet
                ? "Your Production secret is also saved, ready for when you switch."
                : "Pick Production above when you're ready to add your Production secret."
              : saved?.sandboxSecretSet
                ? "Your Sandbox secret is also saved, ready for when you switch back."
                : "Pick Sandbox above to add a Sandbox secret for testing."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!!busy} className={primaryButton}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={test} disabled={!!busy} className={secondaryButton}>
            {busy === "test" ? "Testing…" : `Test ${env === "production" ? "Production" : "Sandbox"} keys`}
          </button>
          {saved &&
            (confirmRemove ? (
              <span className="flex items-center gap-2">
                <button type="button" onClick={remove} disabled={!!busy} className="rounded bg-error px-3 py-2 font-semibold text-white">
                  Remove keys
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} className="px-2 text-subtle hover:underline">
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} className="ml-auto text-error hover:underline">
                Remove
              </button>
            ))}
        </div>
        <Notice msg={msg} />
      </form>
    </Card>
  );
}
