import BudgetPage from "./BudgetPage";
import { BudgetIcon, Logo, LogoutIcon } from "./Icons";

interface Props {
  username: string;
  onLogout: () => void;
}

export default function AppShell({ username, onLogout }: Props) {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <div className="flex min-h-screen bg-page">
      {/* Left icon nav */}
      <nav className="sticky top-0 hidden h-screen w-14 shrink-0 flex-col items-center bg-white py-4 sm:flex">
        <Logo className="size-8" />
        <div className="mt-8 flex flex-col gap-2">
          <a href="#" aria-label="Budget" title="Budget" className="flex size-10 items-center justify-center rounded-lg bg-pressed text-primary">
            <BudgetIcon />
          </a>
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
        <BudgetPage />
      </main>

      {/* Bottom bar on phones */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t border-line bg-white sm:hidden">
        <a href="#" aria-label="Budget" className="flex flex-col items-center text-xs text-primary">
          <BudgetIcon />
          Budget
        </a>
        <button onClick={onLogout} aria-label="Sign out" className="flex flex-col items-center text-xs text-subtle">
          <LogoutIcon />
          Sign out
        </button>
      </nav>
    </div>
  );
}
