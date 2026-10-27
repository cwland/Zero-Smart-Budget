import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import AuthScreen from "./components/AuthScreen";
import AppShell from "./components/AppShell";

type AuthState = { status: "loading" } | { status: "setup" } | { status: "login" } | { status: "in"; username: string };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  const check = useCallback(async () => {
    try {
      const { setupRequired } = await api<{ setupRequired: boolean }>("GET", "/api/auth/status");
      if (setupRequired) return setAuth({ status: "setup" });
      if (!getToken()) return setAuth({ status: "login" });
      const me = await api<{ user?: { username: string } }>("GET", "/api/auth/me");
      setAuth(me.user ? { status: "in", username: me.user.username } : { status: "login" });
    } catch {
      setToken(null);
      setAuth({ status: "login" });
    }
  }, []);

  useEffect(() => {
    check();
    const onLogout = () => setAuth({ status: "login" });
    window.addEventListener("corysdollar:logout", onLogout);
    return () => window.removeEventListener("corysdollar:logout", onLogout);
  }, [check]);

  if (auth.status === "loading") return <div className="min-h-screen bg-page" />;

  if (auth.status === "setup" || auth.status === "login") {
    return (
      <AuthScreen
        mode={auth.status}
        onDone={(token, username) => {
          setToken(token);
          setAuth({ status: "in", username });
        }}
      />
    );
  }

  return (
    <AppShell
      username={auth.username}
      onLogout={() => {
        setToken(null);
        setAuth({ status: "login" });
      }}
    />
  );
}
