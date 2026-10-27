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

export const PiggyIcon = ({ className = "size-5" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 11a7 6 0 0112.6-3.5H20v3l-1.2.8A6 6 0 0117 15.5V19h-3v-2h-3v2H8v-3.2A6 6 0 015 11z" />
    <path d="M9 7.5h3" />
    <circle cx="15.5" cy="10" r=".6" fill="currentColor" />
  </svg>
);

export const GearIcon = ({ className = "size-5" }: P) => (
  <svg viewBox="0 0 24 24" className={`${base} ${className}`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);

export const GripIcon = ({ className = "size-4" }: P) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
);
