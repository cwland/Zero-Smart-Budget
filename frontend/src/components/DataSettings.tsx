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
}

export default function DataSettings() {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [backups, setBackups] = useState<{ dir: string; keep: number; backups: BackupInfo[] } | null>(null);
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
      if (data?.app !== "Cory's Dollar" || !Array.isArray(data.months)) throw new Error();
      setRestore({ name: file.name, data, exportedAt: data.exportedAt, months: data.months.length, transactions: data.transactions?.length ?? 0 });
    } catch {
      setMessage({ kind: "error", text: "That file isn't a Cory's Dollar backup" });
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
          <button
            disabled={busy}
            className={`${button} mt-4`}
            onClick={() =>
              run(async () => {
                const made = await api<{ name: string }>("POST", "/api/backups");
                await loadBackups();
                return `Backup saved: ${made.name}`;
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
            Load a backup or "Everything (JSON)" export. This <strong className="text-ink">replaces all budget data</strong> (months, transactions, funds) with what's in the file. Your login stays the same, and a safety backup of the current data is saved first.
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
              <button
                disabled={busy}
                onBlur={() => setConfirmRestore(false)}
                onClick={() => {
                  if (!confirmRestore) return setConfirmRestore(true);
                  void run(async () => {
                    const res = await api<{ safetyBackup: string; months: number; transactions: number }>("POST", "/api/import?confirm=replace", restore.data);
                    setRestore(null);
                    setConfirmRestore(false);
                    await loadBackups();
                    return `Restored ${res.months} months and ${res.transactions} transactions. Your previous data was saved as ${res.safetyBackup}.`;
                  });
                }}
                className={`mt-3 rounded px-4 py-2.5 font-semibold ${confirmRestore ? "bg-error text-white" : "border border-error text-error hover:bg-error-subtle"}`}
              >
                {confirmRestore ? "Yes, replace everything" : "Replace all budget data"}
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
