import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLockBodyScroll } from "../scrollLock";
import { CloseIcon } from "./Icons";

// A centered popup. "wide" for long lists (sign-in history, backups): wider, and a fixed height so
// it doesn't jump around when its contents change (filtering); the list scrolls inside it.
export function Popup({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useLockBodyScroll();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_12px_40px_rgba(31,36,38,0.3)] sm:rounded-2xl ${wide ? "h-[85vh] max-w-[52rem]" : "max-w-[28rem]"}`}>
        <header className="relative flex items-center justify-center bg-page px-12 py-5">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1.5 text-subtle hover:bg-white/70 hover:text-ink">
            <CloseIcon className="size-5" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body
  );
}
