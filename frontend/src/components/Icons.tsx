// App icons from Lucide (lucide.dev, open source, ISC license). Each wrapper keeps the app's own
// name and default size, so screens just use <BankIcon /> etc.
import {
  ChartPie,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  Landmark,
  LogOut,
  PiggyBank,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Star,
  Target,
  Trash2,
  User,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

type P = { className?: string };
const icon = (I: LucideIcon, size: string, strokeWidth = 2) =>
  function AppIcon({ className = size }: P) {
    return <I className={className} strokeWidth={strokeWidth} aria-hidden />;
  };

export const ChevronLeft = icon(LucideChevronLeft, "size-4");
export const ChevronRight = icon(LucideChevronRight, "size-4");
export const ChevronDown = icon(LucideChevronDown, "size-4");
export const ChevronUp = icon(LucideChevronUp, "size-4");
export const Trash = icon(Trash2, "size-4", 1.8);
export const Check = icon(LucideCheck, "size-4", 2.4);
export const BudgetIcon = icon(Wallet, "size-5", 1.8);
export const LogoutIcon = icon(LogOut, "size-5", 1.8);
export const PieIcon = icon(ChartPie, "size-4", 2);
export const BankIcon = icon(Landmark, "size-5", 1.8);
export const GoalIcon = icon(Target, "size-5", 1.9);
export const PlusIcon = icon(Plus, "size-5");
export const PiggyIcon = icon(PiggyBank, "size-5", 1.8);
export const GearIcon = icon(Settings, "size-5", 1.8);
export const GripIcon = icon(GripVertical, "size-4");
export const UserIcon = icon(User, "size-5", 1.8);
export const ResetIcon = icon(RotateCcw, "size-5", 1.8);
export const EyeIcon = icon(Eye, "size-5", 1.8);
export const EyeOffIcon = icon(EyeOff, "size-5", 1.8);
export const CloseIcon = icon(X, "size-6", 1.8);
export const SearchIcon = icon(Search, "size-4");

// Filled when on (favorites)
export function StarIcon({ filled, className = "size-6" }: P & { filled?: boolean }) {
  return <Star className={className} strokeWidth={1.8} fill={filled ? "currentColor" : "none"} aria-hidden />;
}

// Zero Smart Budget mark: green rounded square with a "0" ring and a dot in the middle
export const Logo = ({ className = "size-8" }: P) => (
  <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Zero Smart Budget">
    <rect width="32" height="32" rx="8" fill="#35bd59" />
    <ellipse cx="16" cy="16" rx="7" ry="9" fill="none" stroke="#fff" strokeWidth="3.2" />
    <circle cx="16" cy="16" r="2.4" fill="#fff" />
  </svg>
);
