import { useEffect, useState } from "react";
import BudgetPage from "./BudgetPage";
import FundsPage from "./FundsPage";
import GoalsPage from "./GoalsPage";
import ReportsPage from "./ReportsPage";
import AccountsPage from "./AccountsPage";
import SettingsPage from "./SettingsPage";
import AccountMenu from "./AccountMenu";
import DevResetButton from "./DevReset"; // TEMPORARY testing tool
import { APP_VERSION, showWhatsNew, versionLabel } from "../version";
import { isNewer } from "../changelog";
import { canManage, useSession } from "../session";
import { api } from "../api";
import WhatsNew from "./WhatsNew";
import UpdateBar from "./UpdateBar";
import { BankIcon, BudgetIcon, GearIcon, GoalIcon, Logo, PiggyIcon, ReportsIcon } from "./Icons";

type Page = "budget" | "accounts" | "funds" | "goals" | "reports" | "settings";
const pageFromHash = (): Page => {
  const h = window.location.hash.replace("#/", "").split("/")[0];
  return h === "accounts" || h === "funds" || h === "goals" || h === "reports" || h === "settings" ? h : "budget";
};

const PAGES: { id: Page; label: string; icon: JSX.Element }[] = [
  { id: "budget", label: "Budget", icon: <BudgetIcon /> },
  { id: "accounts", label: "Accounts", icon: <BankIcon /> },
  { id: "funds", label: "Funds", icon: <PiggyIcon /> },
  { id: "goals", label: "Goals", icon: <GoalIcon /> },
  { id: "reports", label: "Reports", icon: <ReportsIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> },
];

export default function AppShell() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const { user, setUser } = useSession();
  // "What's new": once per version after signing in (until dismissed), and from the version number
  const [news, setNews] = useState<"new" | "all" | null>(() => (isNewer(APP_VERSION, user.seenVersion) ? "new" : null));
  const [sinceVersion] = useState(user.seenVersion ?? null);
  useEffect(() => {
    const open = () => setNews("all");
    window.addEventListener("zsb:whats-new", open);
    return () => window.removeEventListener("zsb:whats-new", open);
  }, []);
  const closeNews = () => {
    setNews(null);
    if (isNewer(APP_VERSION, user.seenVersion)) {
      setUser({ ...user, seenVersion: APP_VERSION });
      void api("PUT", "/api/auth/seen-version", { version: APP_VERSION }).catch(() => {});
    }
  };

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="flex min-h-screen bg-page pt-[var(--top-bar,0px)]">
      {canManage(user) && <UpdateBar />}
      {/* Left icon nav */}
      <nav className="sticky top-[var(--top-bar,0px)] z-40 hidden h-[calc(100vh-var(--top-bar,0px))] w-14 shrink-0 flex-col items-center bg-white py-4 sm:flex">
        <span title="Zero Smart Budget: AI-Powered Zero-Based Budgeting">
          <Logo className="size-8" />
        </span>
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
        <div className="mt-auto flex flex-col items-center gap-2">
          {canManage(user) && <DevResetButton />} {/* TEMPORARY testing tool */}
          <AccountMenu variant="rail" />
          <button type="button" onClick={showWhatsNew} className="rounded px-1 text-[10px] leading-none text-muted hover:text-link hover:underline" title="What's new in this version">
            {versionLabel}
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 pb-16 sm:pb-0">
        {page === "accounts" ? <AccountsPage /> : page === "funds" ? <FundsPage /> : page === "goals" ? <GoalsPage /> : page === "reports" ? <ReportsPage /> : page === "settings" ? <SettingsPage /> : <BudgetPage />}
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
        <AccountMenu variant="bar" />
      </nav>
      {news && <WhatsNew since={sinceVersion} all={news === "all"} onClose={closeNews} />}
    </div>
  );
}
