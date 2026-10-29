import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import AuthScreen from "./components/AuthScreen";
import AppShell from "./components/AppShell";
import ResetPasswordScreen from "./components/ResetPasswordScreen";
import { SessionContext, type User } from "./session";

type AuthState =
  | { status: "loading" }
  | { status: "offline" } // the server can't be reached (e.g. restarting): keep the sign-in and retry
  | { status: "setup" }
  | { status: "login"; resetAvailable: boolean }
  | { status: "in"; user: User };

// "#/reset?token=..." from a password reset email
const resetTokenFromHash = () => (window.location.hash.startsWith("#/reset") ? new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("token") : null);

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [resetToken, setResetToken] = useState(resetTokenFromHash);

  const check = useCallback(async () => {
    try {
      const status = await api<{ setupRequired: boolean; resetAvailable: boolean }>("GET", "/api/auth/status");
      if (status.setupRequired) return setAuth({ status: "setup" });
      if (!getToken()) return setAuth({ status: "login", resetAvailable: status.resetAvailable });
      const me = await api<{ user?: User }>("GET", "/api/auth/me");
      setAuth(me.user ? { status: "in", user: me.user } : { status: "login", resetAvailable: status.resetAvailable });
    } catch (e) {
      // Only a "not signed in" answer ends the session. Anything else (server restarting, network
      // down) keeps the sign-in and tries again.
      if (!(e instanceof ApiError) || e.status >= 500) {
        setAuth((a) => (a.status === "in" ? a : { status: "offline" }));
        setTimeout(() => check(), 3000);
        return;
      }
      setToken(null);
      const status = await api<{ resetAvailable: boolean }>("GET", "/api/auth/status").catch(() => ({ resetAvailable: false }));
      setAuth({ status: "login", resetAvailable: status.resetAvailable });
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

  const signedIn = (token: string, user: User) => {
    setToken(token);
    setAuth({ status: "in", user });
  };

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
          <p className="text-lg font-semibold">Can't reach ZeroPoint Budget right now</p>
          <p className="mt-1 text-subtle">The server may be restarting. Trying again…</p>
        </div>
      </div>
    );
  }

  if (auth.status === "setup" || auth.status === "login") {
    return <AuthScreen mode={auth.status} resetAvailable={auth.status === "login" && auth.resetAvailable} onDone={signedIn} />;
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
