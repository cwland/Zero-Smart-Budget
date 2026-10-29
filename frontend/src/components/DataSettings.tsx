import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, downloadFile, type BackupInfo } from "../api";

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
  const [restore, setRestore] = useState<RestoreFile | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

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

  async function pickFile(file: File | undefined) {
    setRestore(null);
    setConfirmRestore(false);
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!["ZeroPoint Budget", "Cory's Dollar"].includes(data?.app) || !Array.isArray(data.months)) throw new Error();
      setRestore({ name: file.name, data, exportedAt: data.exportedAt, months: data.months.length, transactions: data.transactions?.length ?? 0, settings: data.settings?.secrets ?? null });
    } catch {
      setMessage({ kind: "error", text: "That file isn't a ZeroPoint Budget backup" });
    }
  }

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
            {backups?.backups.map((b) => (
              <li key={b.name} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block">{when(b.createdAt)}</span>
                  <span className="block truncate text-sm text-subtle">
                    {b.name} · {kb(b.size)}
                  </span>
                </span>
                <button className="text-sm font-semibold text-link hover:underline" onClick={() => run(async () => `Downloaded ${await downloadFile(`/api/backups/${b.name}`)}`)}>
                  Download
                </button>
              </li>
            ))}
            {backups && backups.backups.length === 0 && <li className="py-4 text-subtle">No backups yet</li>}
          </ul>
        </Card>

        <Card title="Restore">
          <p className="text-subtle">
            Load a backup or "Everything (JSON)" export. This <strong className="text-ink">replaces all budget data</strong> (months, transactions, funds) and the settings saved in the file. Your login stays the same, and a safety backup of the current data is saved first.
          </p>
          <label className="mt-4 block">
            <span className="sr-only">Backup file</span>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Backup file"
              onChange={(e) => pickFile(e.target.files?.[0])}
              className="block w-full text-sm text-subtle file:mr-3 file:rounded file:border-0 file:bg-pressed file:px-4 file:py-2.5 file:font-semibold file:text-primary hover:file:bg-active"
            />
          </label>

          {restore && (
            <div className="mt-4 rounded-lg border border-warning/50 bg-warning/5 p-4">
              <p>
                <strong>{restore.name}</strong>
                {restore.exportedAt && <> from {when(restore.exportedAt)}</>}: {restore.months} month{restore.months === 1 ? "" : "s"}, {restore.transactions} transaction{restore.transactions === 1 ? "" : "s"}.
              </p>
              <p className="mt-1 text-sm text-subtle">
                {restore.settings === null
                  ? "No settings in this file (an older backup); your settings stay as they are."
                  : restore.settings === "encrypted"
                    ? "Includes settings, with keys and passwords encrypted by BACKUP_KEY. They come back if this server has the same BACKUP_KEY."
                    : "Includes settings, but not keys or passwords (made without BACKUP_KEY). Keys you've already saved here are kept."}
              </p>
              <button
                disabled={busy}
                onBlur={() => setConfirmRestore(false)}
                onClick={() => {
                  if (!confirmRestore) return setConfirmRestore(true);
                  void run(async () => {
                    const res = await api<RestoreResult>("POST", "/api/import?confirm=replace", restore.data);
                    setRestore(null);
                    setConfirmRestore(false);
                    await loadBackups();
                    return `Restored ${res.months} months and ${res.transactions} transactions. Your previous data was saved as ${res.safetyBackup}.${settingsNote(res.settings)}`;
                  });
                }}
                className={`mt-3 rounded px-4 py-2.5 font-semibold ${confirmRestore ? "bg-error text-white" : "border border-error text-error hover:bg-error-subtle"}`}
              >
                {confirmRestore ? "Yes, replace everything" : "Replace budget data and settings"}
              </button>
            </div>
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
