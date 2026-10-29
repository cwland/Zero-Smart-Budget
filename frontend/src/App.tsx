import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import AuthScreen from "./components/AuthScreen";
import AppShell from "./components/AppShell";
import ResetPasswordScreen from "./components/ResetPasswordScreen";
import { SessionContext, type User } from "./session";

type AuthState =
  | { status: "loading" }
  | { status: "offline" } // the server can't be reached (e.g. restarting): keep the sign-in and retry
  | { status: "setup" }
  | { status: "login"; resetAvailable: boolean; oauth: { label: string } | null; passwords: boolean; oauthError?: string }
  | { status: "in"; user: User };

type Status = { setupRequired: boolean; resetAvailable: boolean; oauth: { label: string } | null; passwords: boolean };
const loginState = (s: Partial<Status>, oauthError?: string): AuthState => ({ status: "login", resetAvailable: !!s.resetAvailable, oauth: s.oauth ?? null, passwords: s.passwords ?? true, oauthError });

// Back from the OAuth provider: "#/oauth?ticket=..." (signed in) or "#/?oauth_error=..." (not)
function takeOAuthReturn() {
  const [path, query] = window.location.hash.split("?");
  const p = new URLSearchParams(query ?? "");
  const ticket = path === "#/oauth" ? p.get("ticket") : null;
  const error = !path.startsWith("#/settings") ? p.get("oauth_error") : null;
  if (ticket || error) history.replaceState(null, "", "#/");
  return { ticket, error };
}

// "#/reset?token=..." from a password reset email
const resetTokenFromHash = () => (window.location.hash.startsWith("#/reset") ? new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("token") : null);

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [resetToken, setResetToken] = useState(resetTokenFromHash);

  const signedInRef = useRef<(token: string, user: User) => void>(() => {});
  const check = useCallback(async () => {
    try {
      const back = takeOAuthReturn();
      if (back.ticket) {
        const r = await api<{ token: string; user: User }>("POST", "/api/auth/oauth/finish", { ticket: back.ticket }).catch((e) => ({ error: (e as Error).message }));
        if ("token" in r) return signedInRef.current(r.token, r.user);
        back.error = r.error;
      }
      const status = await api<Status>("GET", "/api/auth/status");
      if (status.setupRequired) return setAuth({ status: "setup" });
      if (!getToken() || back.error) return setAuth(loginState(status, back.error ?? undefined));
      const me = await api<{ user?: User }>("GET", "/api/auth/me");
      setAuth(me.user ? { status: "in", user: me.user } : loginState(status));
    } catch (e) {
      // Only a "not signed in" answer ends the session. Anything else (server restarting, network
      // down) keeps the sign-in and tries again.
      if (!(e instanceof ApiError) || e.status >= 500) {
        setAuth((a) => (a.status === "in" ? a : { status: "offline" }));
        setTimeout(() => check(), 3000);
        return;
      }
      setToken(null);
      const status = await api<Status>("GET", "/api/auth/status").catch(() => ({}) as Partial<Status>);
      setAuth(loginState(status));
    }
  }, []);

  useEffect(() => {
    check();
    const onLogout = () => check();
    const onHash = () => setResetToken(resetTokenFromHash());
    window.addEventListener("corysdollar:logout", onLogout);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("corysdollar:logout", onLogout);
      window.removeEventListener("hashchange", onHash);
    };
  }, [check]);

  // Every sign-in starts on the Budget page (which opens on the current month), not on whatever
  // page was in the address bar when you were signed out
  const signedIn = (token: string, user: User) => {
    setToken(token);
    if (window.location.hash !== "#/budget") window.location.hash = "#/budget";
    setAuth({ status: "in", user });
  };
  signedInRef.current = signedIn;


  if (resetToken) {
    return (
      <ResetPasswordScreen
        token={resetToken}
        onDone={(token, user) => {
          window.location.hash = "#/budget";
          setResetToken(null);
          signedIn(token, user);
        }}
        onCancel={() => {
          window.location.hash = "";
          setResetToken(null);
        }}
      />
    );
  }

  if (auth.status === "loading") return <div className="min-h-screen bg-page" />;
  if (auth.status === "offline") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page p-6 text-center">
        <div role="status" className="rounded-2xl bg-white px-8 py-6">
          <p className="text-lg font-semibold">Can't reach Zero Smart Budget right now</p>
          <p className="mt-1 text-subtle">The server may be restarting. Trying again…</p>
        </div>
      </div>
    );
  }

  if (auth.status === "setup" || auth.status === "login") {
    return (
      <AuthScreen
        mode={auth.status}
        resetAvailable={auth.status === "login" && auth.resetAvailable}
        oauth={auth.status === "login" ? auth.oauth : null}
        passwords={auth.status === "login" ? auth.passwords : true}
        initialError={auth.status === "login" ? auth.oauthError : undefined}
        onDone={signedIn}
      />
    );
  }

  const signOut = () => {
    api("POST", "/api/auth/logout").catch(() => {}); // this device shows as signed out
    setToken(null);
    check();
  };

  return (
    <SessionContext.Provider
      value={{
        user: auth.user,
        setUser: (user) => setAuth({ status: "in", user }),
        replaceToken: (token) => setToken(token),
        signOut,
        signOutEverywhere: async () => {
          await api("POST", "/api/auth/logout-all", {});
          signOut();
        },
      }}
    >
      <AppShell />
    </SessionContext.Provider>
  );
}
