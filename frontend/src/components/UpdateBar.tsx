import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { isNewer } from "../changelog";
import { APP_VERSION } from "../version";
import { Popup } from "./Popup";
import { SettingCard, Toggle } from "./BudgetSettings";

export interface UpdateInfo {
  enabled: boolean;
  latest: { version: string; name: string; notes: string; url: string; publishedAt: string | null } | null;
  checkedAt: string | null;
  error: string | null;
  dismissed: string | null;
  repo: string;
}

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

// Release watcher: a slim bar fixed across the top of the app when a newer release is out.
// Checks after signing in and every 3 hours; dismissed, it stays away until the next version.
// While it shows, --top-bar holds its height so the side nav and sticky headers sit below it.
export default function UpdateBar() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [notes, setNotes] = useState(false);

  const load = useCallback(() => {
    api<UpdateInfo>("GET", "/api/updates?check=1")
      .then(setInfo)
      .catch(() => {}); // a failed check just shows nothing
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, CHECK_EVERY_MS);
    const changed = (e: Event) => setInfo((e as CustomEvent<UpdateInfo>).detail); // from Settings › Data
    window.addEventListener("zsb:updates", changed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("zsb:updates", changed);
    };
  }, [load]);

  const latest = info?.latest;
  const show = !!info?.enabled && !!latest && isNewer(latest.version, APP_VERSION) && info.dismissed !== latest.version;

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--top-bar", show ? "2.5rem" : "0px");
    return () => document.documentElement.style.setProperty("--top-bar", "0px");
  }, [show]);

  async function dismiss() {
    if (!latest) return;
    setInfo((i) => (i ? { ...i, dismissed: latest.version } : i));
    setNotes(false);
    await api("PUT", "/api/updates/dismiss", { version: latest.version }).catch(() => {});
  }

  if (!show || !latest) return null;
  return (
    <>
      <div role="status" aria-label="New version available" className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-center gap-3 bg-ink px-4 text-sm text-white">
        <span className="truncate">
          <span className="font-semibold">Version {latest.version} is available!</span>
          <span className="hidden text-white/70 sm:inline"> You're on {APP_VERSION}.</span>
        </span>
        <button type="button" onClick={() => setNotes(true)} className="shrink-0 rounded bg-white px-3 py-1 font-semibold text-ink hover:bg-white/90">
          See What's New
        </button>
        <button type="button" onClick={dismiss} className="shrink-0 rounded px-2 py-1 font-semibold text-white/80 hover:bg-white/10 hover:text-white">
          Dismiss
        </button>
      </div>
      {notes && <ReleaseNotesPopup info={info!} onClose={() => setNotes(false)} onDismiss={dismiss} />}
    </>
  );
}

function ReleaseNotesPopup({ info, onClose, onDismiss }: { info: UpdateInfo; onClose: () => void; onDismiss: () => void }) {
  const r = info.latest!;
  return (
    <Popup title="What's new" wide onClose={onClose}>
      <div className="flex flex-col gap-4 px-6 py-5">
        <div>
          <h3 className="text-lg font-semibold">{r.name}</h3>
          <p className="text-sm text-muted">
            Version {r.version}
            {r.publishedAt && ` · released ${new Date(r.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`} · you're on {APP_VERSION}
          </p>
        </div>
        {r.notes.trim() ? <Markdown text={r.notes} /> : <p className="text-subtle">This release has no notes.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <a href={r.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-link hover:underline">
            View on GitHub
          </a>
          <div className="flex gap-2">
            <button type="button" onClick={onDismiss} className="rounded border border-primary px-4 py-2.5 font-semibold text-primary hover:bg-pressed">
              Dismiss
            </button>
            <button type="button" onClick={onClose} className="rounded bg-primary px-5 py-2.5 font-semibold text-white hover:bg-primary-pressed">
              Got it
            </button>
          </div>
        </div>
      </div>
    </Popup>
  );
}

// Just enough Markdown for release notes: headings, bullet lists, paragraphs, **bold**, `code`, [links](url)
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length} className="list-disc space-y-1.5 pl-5 text-sm">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    if (para.length) blocks.push(<p key={blocks.length} className="text-sm">{inline(para.join(" "))}</p>);
    list = [];
    para = [];
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push(<h4 key={blocks.length} className="pt-1 font-semibold">{inline(heading[1])}</h4>);
    } else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="flex flex-col gap-3">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index}>{m[1]}</strong>);
    else if (m[2]) out.push(<code key={m.index} className="rounded bg-page px-1 font-mono text-xs">{m[2]}</code>);
    else out.push(<a key={m.index} href={m[4]} target="_blank" rel="noreferrer" className="text-link hover:underline">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// Settings › Data › Updates: the on/off switch, what was found, and Check now
export function UpdatesSettings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);

  useEffect(() => {
    api<UpdateInfo>("GET", "/api/updates").then(setInfo).catch((e) => setMsg((e as Error).message));
  }, []);

  const apply = (i: UpdateInfo) => {
    setInfo(i);
    window.dispatchEvent(new CustomEvent("zsb:updates", { detail: i })); // the bar at the top follows
  };
  async function run(fn: () => Promise<UpdateInfo>) {
    setBusy(true);
    setMsg(null);
    try {
      apply(await fn());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const latest = info?.latest;
  const newer = !!latest && isNewer(latest.version, APP_VERSION);
  const ago = info?.checkedAt ? new Date(info.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <SettingCard
      title="Updates"
      text={<>Look for a newer release of Zero Smart Budget on GitHub after you sign in and every 3 hours, and show a bar at the top of the app when one is out.</>}
      toggle={info && <Toggle label="Check for updates" checked={info.enabled} disabled={busy} onChange={(enabled) => run(() => api("PUT", "/api/updates/settings", { enabled }))} />}
    >
      {info?.enabled && (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            You're on version <strong>{APP_VERSION}</strong>.{" "}
            {newer ? (
              <>
                Version <strong>{latest!.version}</strong> is available.{" "}
                <button type="button" onClick={() => setNotes(true)} className="font-semibold text-link hover:underline">
                  See what's new
                </button>
              </>
            ) : latest ? (
              "That's the latest release."
            ) : info.error ? null : (
              "No releases found yet."
            )}
          </p>
          {info.error && (
            <p role="alert" className="rounded-lg bg-error-subtle px-3 py-2 text-error">
              {info.error}
            </p>
          )}
          {msg && (
            <p role="alert" className="text-error">
              {msg}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={() => run(() => api("POST", "/api/updates/check"))} className="rounded border border-primary px-4 py-2 font-semibold text-primary hover:bg-pressed disabled:opacity-60">
              {busy ? "Checking…" : "Check now"}
            </button>
            <span className="text-subtle">
              {ago ? `Last checked ${ago}` : "Not checked yet"} · releases from{" "}
              <a href={`https://github.com/${info.repo}/releases`} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {info.repo}
              </a>
            </span>
          </div>
        </div>
      )}
      {notes && info && <ReleaseNotesPopup info={info} onClose={() => setNotes(false)} onDismiss={async () => { setNotes(false); apply(await api("PUT", "/api/updates/dismiss", { version: info.latest!.version })); }} />}
    </SettingCard>
  );
}
