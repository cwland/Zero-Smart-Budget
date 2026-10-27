// Small inline icons (stroke = currentColor)
type P = { className?: string };
const base = "fill-none stroke-current";

export const ChevronLeft = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
);
export const ChevronRight = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
);
export const ChevronDown = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);
export const ChevronUp = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
);
export const Trash = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>
);
export const Check = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const BudgetIcon = ({ className = "size-5" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={1.8} strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
);
export const LogoutIcon = ({ className = "size-5" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 16l-4-4 4-4M6 12h10" /></svg>
);
export const PieIcon = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={2.2}><path d="M12 3a9 9 0 109 9h-9z" /><path d="M15 3.5A9 9 0 0120.5 9H15z" /></svg>
);

// Cory's Dollar mark: green rounded square with a "C" and a dollar stroke
export const Logo = ({ className = "size-8" }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-label="Cory's Dollar">
    <rect width="32" height="32" rx="8" fill="#35bd59" />
    <path d="M21.5 11.2A7 7 0 1 0 21.5 20.8" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    <path d="M16 7.5v17" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
