import { useEffect, useState } from "react";
import BudgetPage from "./BudgetPage";
import FundsPage from "./FundsPage";
import SettingsPage from "./SettingsPage";
import { BudgetIcon, GearIcon, Logo, LogoutIcon, PiggyIcon } from "./Icons";

type Page = "budget" | "funds" | "settings";
const pageFromHash = (): Page => {
  const h = window.location.hash.replace("#/", "");
  return h === "funds" || h === "settings" ? h : "budget";
};

const PAGES: { id: Page; label: string; icon: JSX.Element }[] = [
  { id: "budget", label: "Budget", icon: <BudgetIcon /> },
  { id: "funds", label: "Funds", icon: <PiggyIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> },
];

interface Props {
  username: string;
  onLogout: () => void;
}

export default function AppShell({ username, onLogout }: Props) {
  const initials = username.slice(0, 2).toUpperCase();
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="flex min-h-screen bg-page">
      {/* Left icon nav */}
      <nav className="sticky top-0 hidden h-screen w-14 shrink-0 flex-col items-center bg-white py-4 sm:flex">
        <Logo className="size-8" />
        <div className="mt-8 flex flex-col gap-2">
          {PAGES.map((p) => (
            <a
              key={p.id}
              href={`#/${p.id}`}
              aria-label={p.label}
              title={p.label}
              aria-current={page === p.id ? "page" : undefined}
              className={`flex size-10 items-center justify-center rounded-lg ${page === p.id ? "bg-pressed text-primary" : "text-subtle hover:bg-page"}`}
            >
              {p.icon}
            </a>
          ))}
        </div>
        <div className="mt-auto flex flex-col items-center gap-3">
          <button onClick={onLogout} aria-label="Sign out" title="Sign out" className="flex size-10 items-center justify-center rounded-lg text-subtle hover:bg-page">
            <LogoutIcon />
          </button>
          <div title={username} className="flex size-9 items-center justify-center rounded-full bg-page text-xs font-semibold text-ink">
            {initials}
          </div>
        </div>
      </nav>

      <main className="min-w-0 flex-1 pb-16 sm:pb-0">
        {page === "funds" ? <FundsPage /> : page === "settings" ? <SettingsPage /> : <BudgetPage />}
      </main>

      {/* Bottom bar on phones */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t border-line bg-white sm:hidden">
        {PAGES.map((p) => (
          <a
            key={p.id}
            href={`#/${p.id}`}
            aria-label={p.label}
            aria-current={page === p.id ? "page" : undefined}
            className={`flex flex-col items-center text-xs ${page === p.id ? "text-primary" : "text-subtle"}`}
          >
            {p.icon}
            {p.label}
          </a>
        ))}
        <button onClick={onLogout} aria-label="Sign out" className="flex flex-col items-center text-xs text-subtle">
          <LogoutIcon />
          Sign out
        </button>
      </nav>
    </div>
  );
}
