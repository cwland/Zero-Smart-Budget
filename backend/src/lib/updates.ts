import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { logEvent } from "./appLog.js";

// Release watcher: looks for a newer published release on GitHub (on sign-in, at most every few
// minutes, and every UPDATE_CHECK_HOURS on the server). The bar at the top of the app compares it
// with the version that's running. A private repo needs GITHUB_TOKEN (read-only) in .env.
// Settings live in app_settings under "updates".

export interface Release {
  version: string; // "0.3.0" (the tag without its "v")
  name: string;
  notes: string; // the release notes (Markdown)
  url: string;
  publishedAt: string | null;
}

export interface UpdateState {
  enabled: boolean;
  latest: Release | null;
  checkedAt: string | null;
  error: string | null;
}

export type UpdateFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const DEFAULTS: UpdateState = { enabled: true, latest: null, checkedAt: null, error: null };
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export class UpdateService {
  constructor(
    private db: Db,
    readonly repo: string,
    private token: string | null,
    private fetchImpl: UpdateFetch = fetch as unknown as UpdateFetch,
    private now: () => Date = () => new Date()
  ) {}

  async state(): Promise<UpdateState> {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "updates"));
    return { ...DEFAULTS, ...((row?.value ?? {}) as Partial<UpdateState>) };
  }

  private async save(value: UpdateState) {
    await this.db
      .insert(appSettings)
      .values({ key: "updates", value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    return value;
  }

  async setEnabled(enabled: boolean) {
    return this.save({ ...(await this.state()), enabled, ...(enabled ? {} : { error: null }) });
  }

  /** Ask GitHub for the latest release. With maxAgeMs: skip it when the last check is newer than that. */
  async check({ maxAgeMs }: { maxAgeMs?: number } = {}): Promise<UpdateState> {
    const s = await this.state();
    if (!s.enabled) return s;
    if (maxAgeMs !== undefined && s.checkedAt && this.now().getTime() - new Date(s.checkedAt).getTime() < maxAgeMs) return s;

    let latest = s.latest;
    let error: string | null = null;
    try {
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "zero-smart-budget", "x-github-api-version": "2022-11-28" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const r = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/releases/latest`, { headers });
      if (r.status === 200) {
        const j = (await r.json()) as { tag_name?: string; name?: string | null; body?: string | null; html_url?: string; published_at?: string | null };
        const m = SEMVER.exec(j.tag_name ?? "");
        if (!m) error = `The latest release's tag (${j.tag_name ?? "none"}) isn't a version number like v1.2.3`;
        else latest = { version: `${m[1]}.${m[2]}.${m[3]}`, name: j.name || `Version ${m[1]}.${m[2]}.${m[3]}`, notes: (j.body ?? "").slice(0, 20000), url: j.html_url ?? `https://github.com/${this.repo}/releases`, publishedAt: j.published_at ?? null };
      } else if (r.status === 404) {
        latest = null;
        error = this.token
          ? `No published release found in ${this.repo} (or GITHUB_TOKEN can't read it)`
          : `No published release found in ${this.repo}. If the repository is private, add a read-only GITHUB_TOKEN to .env.`;
      } else if (r.status === 401 || r.status === 403) {
        error = r.status === 401 ? "GitHub didn't accept GITHUB_TOKEN" : "GitHub refused the request (rate limit or token permissions)";
      } else {
        error = `GitHub answered ${r.status}`;
      }
    } catch (e) {
      error = `Couldn't reach GitHub: ${(e as Error).message}`;
    }

    // Settings > Logs: a new problem (not the same one every few hours), and each new version found
    if (error && error !== s.error) await logEvent(this.db, { category: "schedule", level: "warning", source: "Update check", event: "Couldn't check for a new version", detail: error });
    if (latest && latest.version !== s.latest?.version) await logEvent(this.db, { category: "schedule", level: "info", source: "Update check", event: `Latest release: version ${latest.version}`, detail: latest.url });
    return this.save({ enabled: true, latest, checkedAt: this.now().toISOString(), error });
  }
}
