import { useEffect, useState } from "react";
import BudgetPage from "./BudgetPage";
import FundsPage from "./FundsPage";
import SettingsPage from "./SettingsPage";
import AccountMenu from "./AccountMenu";
import DevResetButton from "./DevReset"; // TEMPORARY testing tool
import { BudgetIcon, GearIcon, Logo, PiggyIcon } from "./Icons";

type Page = "budget" | "funds" | "settings";
const pageFromHash = (): Page => {
  const h = window.location.hash.replace("#/", "").split("/")[0];
  return h === "funds" || h === "settings" ? h : "budget";
};

const PAGES: { id: Page; label: string; icon: JSX.Element }[] = [
  { id: "budget", label: "Budget", icon: <BudgetIcon /> },
  { id: "funds", label: "Funds", icon: <PiggyIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> },
];

export default function AppShell() {
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="flex min-h-screen bg-page">
      {/* Left icon nav */}
      <nav className="sticky top-0 z-40 hidden h-screen w-14 shrink-0 flex-col items-center bg-white py-4 sm:flex">
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
        <div className="mt-auto flex flex-col items-center gap-2">
          <DevResetButton /> {/* TEMPORARY testing tool */}
          <AccountMenu variant="rail" />
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
        <AccountMenu variant="bar" />
      </nav>
    </div>
  );
}
