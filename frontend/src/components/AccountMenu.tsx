import { showWhatsNew, versionLabel } from "../version";
import { useEffect, useRef, useState } from "react";
import { initialsOf, useSession } from "../session";
import { LogoutIcon, ResetIcon, UserIcon } from "./Icons";
import { DevResetDialog } from "./DevReset"; // TEMPORARY testing tool

// The initials button (bottom of the left nav, or "Account" on phones) and its menu
export default function AccountMenu({ variant }: { variant: "rail" | "bar" }) {
  const { user, signOut, signOutEverywhere } = useSession();
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [resetOpen, setResetOpen] = useState(false); // TEMPORARY testing tool
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => setConfirmAll(false), [open]);

  const name = user.displayName?.trim() || user.username;
  const item = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-page";

  return (
    <div ref={boxRef} className="relative">
      {variant === "rail" ? (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={open}
          title={name}
          className={`flex size-10 items-center justify-center rounded-full text-xs font-semibold ${open ? "bg-active text-primary" : "bg-page text-ink hover:bg-pressed"}`}
        >
          {initialsOf(user)}
        </button>
      ) : (
        <button onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} className={`flex flex-col items-center text-xs ${open ? "text-primary" : "text-subtle"}`}>
          <UserIcon />
          Account
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={`absolute z-50 w-64 rounded-2xl bg-white p-2 shadow-[0_8px_24px_rgba(31,36,38,0.18)] ${variant === "rail" ? "bottom-0 left-full ml-3" : "bottom-full right-0 mb-3"}`}
        >
          <div className="px-3 py-2">
            <div className="truncate font-semibold">{name}</div>
            <div className="truncate text-sm text-subtle">{user.email ?? `@${user.username}`}</div>
          </div>
          <div className="my-1 h-px bg-line" />
          <a role="menuitem" href="#/settings/profile" onClick={() => setOpen(false)} className={item}>
            <UserIcon className="size-4 text-subtle" /> Profile & security
          </a>
          <button role="menuitem" onClick={signOut} className={item}>
            <LogoutIcon className="size-4 text-subtle" /> Sign out
          </button>
          <button
            role="menuitem"
            onClick={() => (confirmAll ? void signOutEverywhere() : setConfirmAll(true))}
            className={`${item} ${confirmAll ? "bg-error-subtle font-semibold text-error hover:bg-error-subtle" : "text-error"}`}
          >
            <LogoutIcon className="size-4" /> {confirmAll ? "Sign out all devices?" : "Sign out everywhere"}
          </button>
          {/* On phones there's no left nav, so the version shows here */}
          {variant === "bar" && (
            <button type="button" role="menuitem" onClick={() => (setOpen(false), showWhatsNew())} className="block w-full px-3 pb-1 pt-2 text-left text-xs text-muted hover:text-link">
              Zero Smart Budget {versionLabel} · What's new
            </button>
          )}
          {/* TEMPORARY testing tool (phones; on larger screens it's in the left nav) */}
          {variant === "bar" && (
            <>
              <div className="my-1 h-px bg-line" />
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setResetOpen(true);
                }}
                className={`${item} text-error`}
              >
                <ResetIcon className="size-4" /> Reset (testing)
              </button>
            </>
          )}
        </div>
      )}
      {resetOpen && <DevResetDialog onClose={() => setResetOpen(false)} />}
    </div>
  );
}
