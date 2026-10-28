import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import AuthScreen from "./components/AuthScreen";
import AppShell from "./components/AppShell";
import ResetPasswordScreen from "./components/ResetPasswordScreen";
import { SessionContext, type User } from "./session";

type AuthState =
  | { status: "loading" }
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
    } catch {
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

  if (auth.status === "setup" || auth.status === "login") {
    return <AuthScreen mode={auth.status} resetAvailable={auth.status === "login" && auth.resetAvailable} onDone={signedIn} />;
  }

  const signOut = () => {
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
