import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, type TestApp } from "./helpers.js";
import { signToken } from "../src/lib/auth.js";

let t: TestApp;
beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  await t.login(); // the account is set up here (first session)
});

const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const login = async (userAgent: string, ip: string, password = "password123") => {
  const res = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "Cory", password }, headers: { "user-agent": userAgent, "x-forwarded-for": ip } });
  return { status: res.statusCode, token: res.json().token as string };
};
const as = (token: string) => (method: string, url: string, payload?: object) =>
  t.app.inject({ method: method as "GET", url, payload, headers: { authorization: `Bearer ${token}`, "user-agent": "test" } }).then((r) => ({ status: r.statusCode, body: r.body ? r.json() : undefined }));

describe("signed-in devices", () => {
  it("lists each sign-in with its device, address and times; marks this one", async () => {
    const mac = await login(MAC_CHROME, "192.168.1.20");
    const phone = await login(IPHONE, "10.0.0.7");
    const list = (await as(mac.token)("GET", "/api/auth/sessions")).body;
    expect(list).toHaveLength(3); // set up + mac + phone
    const byDevice = Object.fromEntries(list.map((s: any) => [s.device.label, s]));
    expect(byDevice["Chrome on Mac"]).toMatchObject({ current: true, status: "active", how: "password", ip: "192.168.1.20" });
    expect(byDevice["Safari on iPhone"]).toMatchObject({ current: false, status: "active", ip: "10.0.0.7" });
    expect(new Date(byDevice["Chrome on Mac"].expiresAt).getTime() - new Date(byDevice["Chrome on Mac"].createdAt).getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it("signs out one device; its token stops working, the others keep going", async () => {
    const mac = await login(MAC_CHROME, "192.168.1.20");
    const phone = await login(IPHONE, "10.0.0.7");
    const phoneId = (await as(mac.token)("GET", "/api/auth/sessions")).body.find((s: any) => s.device.os === "iPhone").id;
    expect((await as(mac.token)("DELETE", `/api/auth/sessions/${phoneId}`)).status).toBe(204);
    expect((await as(phone.token)("GET", "/api/months")).status).toBe(401);
    expect((await as(mac.token)("GET", "/api/months")).status).toBe(200);
    expect((await as(mac.token)("GET", "/api/auth/sessions")).body.find((s: any) => s.id === phoneId)).toMatchObject({ status: "signed out" });
    expect((await as(mac.token)("DELETE", `/api/auth/sessions/${phoneId}`)).status).toBe(404); // already out
  });

  it("sign out this device, and sign out everywhere else", async () => {
    const mac = await login(MAC_CHROME, "192.168.1.20");
    const phone = await login(IPHONE, "10.0.0.7");
    const r = await as(mac.token)("POST", "/api/auth/logout-all", { keepThisDevice: true });
    expect((await as(phone.token)("GET", "/api/months")).status).toBe(401);
    expect((await as(r.body.token)("GET", "/api/months")).status).toBe(200);
    const list = (await as(r.body.token)("GET", "/api/auth/sessions")).body;
    expect(list.filter((s: any) => s.status === "active")).toHaveLength(1);
    expect(list.find((s: any) => s.current).device.label).toBe("Chrome on Mac"); // same device, fresh token

    await as(r.body.token)("POST", "/api/auth/logout");
    expect((await as(r.body.token)("GET", "/api/months")).status).toBe(401);
  });

  it("changing the password keeps this device and signs out the rest", async () => {
    const mac = await login(MAC_CHROME, "192.168.1.20");
    const phone = await login(IPHONE, "10.0.0.7");
    const r = await as(mac.token)("POST", "/api/auth/password", { currentPassword: "password123", newPassword: "newpassword1" });
    expect((await as(phone.token)("GET", "/api/months")).status).toBe(401);
    const list = (await as(r.body.token)("GET", "/api/auth/sessions")).body;
    expect(list.filter((s: any) => s.status === "active").map((s: any) => s.device.label)).toEqual(["Chrome on Mac"]);
  });

  it("a token from before devices were tracked shows up the first time it's used", async () => {
    const old = signToken(1, 0, "test-secret-that-is-long-enough"); // no device id
    expect((await as(old)("GET", "/api/months")).status).toBe(200);
    const list = (await as(old)("GET", "/api/auth/sessions")).body;
    expect(list.find((s: any) => s.current)).toMatchObject({ how: "earlier sign-in", status: "active" });
    // ...and can be signed out like any other
    const mac = await login(MAC_CHROME, "192.168.1.20");
    await as(mac.token)("DELETE", `/api/auth/sessions/${list.find((s: any) => s.current).id}`);
    expect((await as(old)("GET", "/api/months")).status).toBe(401);
  });
});

describe("sign-in history", () => {
  it("records good and bad attempts with device and address", async () => {
    await login(MAC_CHROME, "192.168.1.20", "nope-nope");
    await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "mallory", password: "x" }, headers: { "x-forwarded-for": "203.0.113.9" } });
    const ok = await login(IPHONE, "10.0.0.7");
    const events = (await as(ok.token)("GET", "/api/auth/logins")).body;
    expect(events.slice(0, 3).map((e: any) => [e.success, e.reason, e.ip, e.device.label, e.username])).toEqual([
      [true, "Signed in with password", "10.0.0.7", "Safari on iPhone", "Cory"],
      [false, "Unknown username", "203.0.113.9", "Unknown browser", "mallory"],
      [false, "Wrong password", "192.168.1.20", "Chrome on Mac", "Cory"],
    ]);
    expect(events.at(-1)).toMatchObject({ success: true, reason: "Account set up" });
  });

  it("keeps 60 days of history", async () => {
    const ok = await login(IPHONE, "10.0.0.7");
    const day = 24 * 3600 * 1000;
    await t.db.execute(sql`insert into login_events (username, success, reason, ip, at) values
      ('Cory', true, 'old', '1.1.1.1', ${new Date(Date.now() - 61 * day)}), ('Cory', true, 'recent', '1.1.1.2', ${new Date(Date.now() - 59 * day)})`);
    const reasons = (await as(ok.token)("GET", "/api/auth/logins")).body.map((e: any) => e.reason);
    expect(reasons).toContain("recent");
    expect(reasons).not.toContain("old");
    const left = await t.db.execute(sql`select count(*)::int as n from login_events where reason = 'old'`);
    expect((left as any).rows?.[0]?.n ?? (left as any)[0]?.n).toBe(0); // deleted, not just hidden
  });

  it("logs blocked attempts after too many failures", async () => {
    for (let i = 0; i < 5; i++) await login(MAC_CHROME, "198.51.100.4", "wrong-pass");
    expect((await login(MAC_CHROME, "198.51.100.4")).status).toBe(429);
    const ok = await login(IPHONE, "10.0.0.7");
    const events = (await as(ok.token)("GET", "/api/auth/logins")).body;
    expect(events[1]).toMatchObject({ success: false, reason: "Blocked: too many failed attempts", ip: "198.51.100.4" });
  });
});
