import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, downloadFile, type BackupInfo } from "../api";
import { Popup } from "./Popup";

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl bg-white p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const button = "rounded border border-primary px-4 py-2.5 font-semibold text-primary hover:bg-pressed disabled:opacity-60";

interface RestoreFile {
  name: string;
  data: unknown;
  exportedAt?: string;
  months: number;
  transactions: number;
  settings: "encrypted" | "left out" | null; // null: an older backup without settings
}

interface BackupsState {
  dir: string;
  keep: number;
  secretsIncluded: boolean;
  backupKeyProblem: string | null;
  backups: BackupInfo[];
}

interface RestoreResult {
  safetyBackup: string;
  months: number;
  transactions: number;
  settings: { settingsRestored: number; secretsRestored: number; secretsKept: number; secretsMissing: number } | null;
}

// What happened to settings in a restore, in a sentence
function settingsNote(s: RestoreResult["settings"]) {
  if (!s) return " This backup has no settings, so yours were left as they are.";
  let text = " Settings were restored too.";
  if (s.secretsMissing) text += ` ${s.secretsMissing} saved key${s.secretsMissing === 1 ? "" : "s"} or password${s.secretsMissing === 1 ? "" : "s"} couldn't be brought back (the backup was made without BACKUP_KEY, or with a different one). Enter ${s.secretsMissing === 1 ? "it" : "them"} again in Settings.`;
  return text;
}

export default function DataSettings() {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [backups, setBackups] = useState<BackupsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [allBackups, setAllBackups] = useState(false);
  const download = (b: BackupInfo) => run(async () => `Downloaded ${await downloadFile(`/api/backups/${b.name}`)}`);
  // Inside the popup: the message shows there, so the page behind doesn't move
  const [popupMsg, setPopupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const downloadInPopup = async (b: BackupInfo) => {
    setPopupMsg(null);
    try {
      setPopupMsg({ ok: true, text: `Downloaded ${await downloadFile(`/api/backups/${b.name}`)}` });
    } catch (e) {
      setPopupMsg({ ok: false, text: (e as Error).message });
    }
  };

  const loadBackups = useCallback(async () => {
    setBackups(await api("GET", "/api/backups"));
  }, []);

  useEffect(() => {
    loadBackups().catch((e) => setMessage({ kind: "error", text: e.message }));
  }, [loadBackups]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "ok", text });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className={`mb-6 rounded-lg px-4 py-3 ${message.kind === "error" ? "bg-error-subtle text-error" : "bg-success-subtle text-success"}`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <Card title="Export">
          <p className="text-subtle">Download your data. CSV files open in Excel, Numbers or Google Sheets.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button disabled={busy} className={button} onClick={() => run(async () => `Downloaded ${await downloadFile("/api/export")}`)}>
              Everything (JSON)
            </button>
            <button disabled={busy} className={button} onClick={() => run(async () => `Downloaded ${await downloadFile("/api/export/transactions.csv")}`)}>
              Transactions (CSV)
            </button>
            <button disabled={busy} className={button} onClick={() => run(async () => `Downloaded ${await downloadFile("/api/export/budget.csv")}`)}>
              Budget (CSV)
            </button>
          </div>
        </Card>

        <Card title="Backups">
          <p className="text-subtle">
            A backup is saved automatically once a day, and the newest {backups?.keep ?? 30} are kept.
            {backups && (
              <>
                {" "}They're stored on the server in <code className="rounded bg-page px-1.5 py-0.5 text-sm text-ink">{backups.dir}</code>.
              </>
            )}
          </p>
          {backups && <BackupKeyStatus info={backups} />}
          <button
            disabled={busy}
            className={`${button} mt-4`}
            onClick={() =>
              run(async () => {
                const made = await api<{ name: string }>("POST", "/api/backups");
                await loadBackups();
                return `Backup saved: ${made.name}${backups?.secretsIncluded ? ". Remember: restoring its keys and passwords needs your BACKUP_KEY." : ""}`;
              })
            }
          >
            Back up now
          </button>

          <ul aria-label="Saved backups" className="mt-4 divide-y divide-line">
            {backups?.backups.slice(0, 5).map((b) => <BackupRow key={b.name} b={b} onDownload={() => download(b)} />)}
            {backups && backups.backups.length === 0 && <li className="py-4 text-subtle">No backups yet</li>}
          </ul>
          {backups && backups.backups.length > 5 && (
            <div className="mt-3 flex justify-center">
              <button type="button" onClick={() => setAllBackups(true)} className="rounded px-4 py-2 text-sm font-semibold text-link hover:bg-pressed">
                View all ({Math.min(backups.backups.length, 30)})
              </button>
            </div>
          )}
          {allBackups && backups && (
            <Popup title="Backups" wide tall onClose={() => (setAllBackups(false), setPopupMsg(null))}>
              <p className="px-6 pt-4 text-sm text-subtle">The newest 30 backups, newest first.</p>
              {popupMsg && (
                <p role={popupMsg.ok ? "status" : "alert"} className={`mx-6 mt-3 rounded-lg px-3 py-2 text-sm ${popupMsg.ok ? "bg-success-subtle text-success" : "bg-error-subtle text-error"}`}>
                  {popupMsg.text}
                </p>
              )}
              <ul aria-label="All backups" className="divide-y divide-line px-6 pb-6">
                {backups.backups.slice(0, 30).map((b) => (
                  <BackupRow key={b.name} b={b} onDownload={() => downloadInPopup(b)} />
                ))}
              </ul>
            </Popup>
          )}
        </Card>

        <Card title="Restore">
          <p className="text-subtle">
            Load a backup or "Everything (JSON)" export. This <strong className="text-ink">replaces all budget data</strong> (months, transactions, funds) and the settings saved in the file. Your login stays the same, and a safety backup of the current data is saved first.
          </p>
          <button type="button" disabled={busy} onClick={() => (setMessage(null), setRestoring(true))} className={`${button} mt-4`}>
            Restore from a file…
          </button>
          {restoring && (
            <RestoreDialog
              onClose={() => setRestoring(false)}
              onDone={async (text) => {
                setRestoring(false);
                setMessage({ kind: "ok", text });
                await loadBackups();
              }}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

// Whether saved keys and passwords go into backups (only with BACKUP_KEY set on the server)
function BackupKeyStatus({ info }: { info: BackupsState }) {
  // Key set: just the reminder to keep it safe
  if (info.secretsIncluded)
    return (
      <div className="mt-3 text-sm">
        <SaveKeyReminder />
      </div>
    );
  return (
    <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-sm">
      <p>
        Backups include your settings, but <strong>not saved keys or passwords</strong> (AI keys, email password, Plaid secrets).
        {info.backupKeyProblem && <span className="text-error"> {info.backupKeyProblem}.</span>}
      </p>
      <p className="mt-1 text-subtle">To include them, encrypted, add a long random BACKUP_KEY on the server and restart it:</p>
      <pre className="mt-2 overflow-x-auto rounded bg-ink p-3 font-mono text-xs leading-relaxed text-white">{`# .env (running with npm: backend/.env)
BACKUP_KEY=a-long-random-string-at-least-16-characters

# make one:
openssl rand -base64 32`}</pre>
      <SaveKeyReminder />
    </div>
  );
}

function SaveKeyReminder() {
  return (
    <p role="note" className="mt-2 rounded border border-error/40 bg-error-subtle px-3 py-2 font-semibold text-error">
      ⚠️ Save your BACKUP_KEY somewhere safe, away from this server (a password manager is ideal). If the server is lost, you can't restore your saved keys and passwords without it, and it can't be recovered.
    </p>
  );
}

function BackupRow({ b, onDownload }: { b: BackupInfo; onDownload: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block">{when(b.createdAt)}</span>
        <span className="block truncate text-sm text-subtle">
          {b.name} · {kb(b.size)}
        </span>
      </span>
      <button className="text-sm font-semibold text-link hover:underline" onClick={onDownload}>
        Download
      </button>
    </li>
  );
}

// Restore: pick a file, see what's in it, optionally give the backup key of the server it came
// from, then confirm. Nothing changes until the last click.
function RestoreDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [file, setFile] = useState<RestoreFile | null>(null);
  const [fileError, setFileError] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pick(f: File | undefined) {
    setFile(null);
    setFileError("");
    setError("");
    setConfirm(false);
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!["Zero Smart Budget", "ZeroPoint Budget", "Cory's Dollar"].includes(data?.app) || !Array.isArray(data.months)) throw new Error();
      setFile({ name: f.name, data, exportedAt: data.exportedAt, months: data.months.length, transactions: data.transactions?.length ?? 0, settings: data.settings?.secrets ?? null });
    } catch {
      setFileError("That file isn't a Zero Smart Budget backup.");
    }
  }

  async function restore() {
    if (!file) return;
    if (!confirm) return setConfirm(true);
    setBusy(true);
    setError("");
    try {
      const res = await api<RestoreResult>("POST", "/api/import?confirm=replace", file.data, key.trim() ? { "x-backup-key": key.trim() } : undefined);
      onDone(`Restored ${res.months} month${res.months === 1 ? "" : "s"} and ${res.transactions} transaction${res.transactions === 1 ? "" : "s"}. Your previous data was saved as ${res.safetyBackup}.${settingsNote(res.settings)}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popup title="Restore from a backup" onClose={onClose}>
      <div className="flex flex-col gap-4 p-6">
        <label className="block text-sm font-medium text-subtle">
          Backup file
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Backup file"
            onChange={(e) => pick(e.target.files?.[0])}
            className="mt-1 block w-full text-sm text-subtle file:mr-3 file:rounded file:border-0 file:bg-pressed file:px-4 file:py-2.5 file:font-semibold file:text-primary hover:file:bg-active"
          />
        </label>
        {fileError && <p role="alert" className="text-sm text-error">{fileError}</p>}

        {file && (
          <>
            <div className="rounded-lg bg-page p-3 text-sm">
              <p>
                <strong>{file.name}</strong>
                {file.exportedAt && <> from {when(file.exportedAt)}</>}
              </p>
              <p className="mt-0.5">
                {file.months} month{file.months === 1 ? "" : "s"}, {file.transactions} transaction{file.transactions === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-subtle">
                {file.settings === null
                  ? "No settings in this file (an older backup); your settings stay as they are."
                  : file.settings === "encrypted"
                    ? "Includes settings, with keys and passwords encrypted by a BACKUP_KEY."
                    : "Includes settings, but not keys or passwords (made without BACKUP_KEY). Keys already saved here are kept."}
              </p>
            </div>

            {file.settings === "encrypted" && (
              <label className="block text-sm font-medium text-subtle">
                Backup key <span className="font-normal text-muted">(only if it came from another server)</span>
                <span className="relative mt-1 block">
                  <input
                    aria-label="Backup key"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    style={showKey ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
                    placeholder="Leave blank to use this server's BACKUP_KEY"
                    value={key}
                    onChange={(e) => (setKey(e.target.value), setError(""))}
                    className="w-full rounded border border-muted/50 bg-white px-3 py-2 pr-14 font-mono text-sm outline-none focus:border-action focus:ring-2 focus:ring-action/15"
                  />
                  <button type="button" onClick={() => setShowKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-xs font-semibold text-link">
                    {showKey ? "Hide" : "Show"}
                  </button>
                </span>
                <span className="mt-1 block font-normal">The BACKUP_KEY of the server that made this backup. It's used for this restore only and isn't saved. If it doesn't match, nothing changes.</span>
              </label>
            )}

            {error && <p role="alert" className="rounded-lg bg-error-subtle px-3 py-2 text-sm text-error">{error}</p>}

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
              <button type="button" onClick={onClose} className="px-3 py-2.5 font-semibold text-subtle hover:underline">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void restore()}
                className={`rounded px-4 py-2.5 font-semibold disabled:opacity-60 ${confirm ? "bg-error text-white" : "border border-error text-error hover:bg-error-subtle"}`}
              >
                {busy ? "Restoring…" : confirm ? "Yes, replace everything" : "Replace budget data and settings"}
              </button>
            </div>
          </>
        )}
      </div>
    </Popup>
  );
}
