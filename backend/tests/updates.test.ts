import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login();
});

const release = (tag: string, body = "- New thing\n- Fixed thing") => () => ({
  status: 200,
  json: { tag_name: tag, name: `Version ${tag.replace("v", "")}`, body, html_url: `https://github.com/cwland/Corys_Dollar/releases/tag/${tag}`, published_at: "2026-11-01T12:00:00Z" },
});
const get = async (q = "?check=1") => (await t.api("GET", `/api/updates${q}`)).body;

describe("release watcher", () => {
  it("finds the latest release on GitHub", async () => {
    t.github.respond = release("v0.3.0");
    const r = await get();
    expect(r).toMatchObject({ enabled: true, error: null, dismissed: null, repo: "cwland/Corys_Dollar", latest: { version: "0.3.0", name: "Version 0.3.0", notes: "- New thing\n- Fixed thing" } });
    expect(t.github.calls[0].url).toBe("https://api.github.com/repos/cwland/Corys_Dollar/releases/latest");
    expect(t.github.calls[0].headers.authorization).toBeUndefined();
    const logs = (await t.api("GET", "/api/logs?category=schedule")).body;
    expect(logs.map((l: any) => l.event)).toEqual(["Latest release: version 0.3.0"]);
  });

  it("asks GitHub at most every 10 minutes from sign-ins; Check now always asks", async () => {
    t.github.respond = release("v0.3.0");
    await get();
    await get();
    expect(t.github.calls).toHaveLength(1);
    expect((await get("")).latest.version).toBe("0.3.0"); // no check at all
    t.clock.date = new Date(Date.now() + 11 * 60 * 1000);
    t.github.respond = release("v0.4.0");
    expect((await get()).latest.version).toBe("0.4.0");
    expect((await t.api("POST", "/api/updates/check")).body.latest.version).toBe("0.4.0");
    expect(t.github.calls).toHaveLength(3);
  });

  it("dismissing hides that version only", async () => {
    t.github.respond = release("v0.3.0");
    await get();
    expect((await t.api("PUT", "/api/updates/dismiss", { version: "0.3.0" })).body.dismissed).toBe("0.3.0");
    expect((await get("")).dismissed).toBe("0.3.0");
    expect((await t.api("PUT", "/api/updates/dismiss", { version: "latest" })).status).toBe(400);
  });

  it("explains problems (logging each new one once) and keeps the last release it saw", async () => {
    t.github.respond = release("v0.3.0");
    await t.api("POST", "/api/updates/check");
    t.github.down = true;
    const r = (await t.api("POST", "/api/updates/check")).body;
    expect(r.error).toMatch(/Couldn't reach GitHub/);
    expect(r.latest.version).toBe("0.3.0");
    await t.api("POST", "/api/updates/check");
    t.github.down = false;
    t.github.respond = () => ({ status: 404, json: {} });
    expect((await t.api("POST", "/api/updates/check")).body.error).toMatch(/private, add a read-only GITHUB_TOKEN/);
    t.github.respond = release("nightly");
    expect((await t.api("POST", "/api/updates/check")).body.error).toMatch(/isn't a version number/);
    const logs = (await t.api("GET", "/api/logs?category=schedule")).body;
    expect(logs.filter((l: any) => l.event === "Couldn't check for a new version")).toHaveLength(3);
  });

  it("turned off: never asks GitHub", async () => {
    const r = (await t.api("PUT", "/api/updates/settings", { enabled: false })).body;
    expect(r.enabled).toBe(false);
    await get();
    await t.api("POST", "/api/updates/check");
    expect(t.github.calls).toHaveLength(0);
    t.github.respond = release("v0.3.0");
    expect((await t.api("PUT", "/api/updates/settings", { enabled: true })).body.latest.version).toBe("0.3.0");
  });

  it("signed in only", async () => {
    const key = (await t.api("POST", "/api/keys", { name: "n8n", access: "read" })).body.key;
    t.setToken("");
    expect((await t.api("GET", "/api/updates", undefined, { "x-api-key": key })).status).toBe(403);
  });
});

describe("with GITHUB_TOKEN", () => {
  it("sends it (for a private repository)", async () => {
    const t2 = await setupTestApp({ githubToken: "ghp_test" });
    try {
      await t2.reset();
      await t2.login();
      t2.github.respond = release("v1.0.0");
      await t2.api("POST", "/api/updates/check");
      expect(t2.github.calls[0].headers.authorization).toBe("Bearer ghp_test");
    } finally {
      await t2.close();
    }
  });
});
