// Small fetch wrapper. The login token lives in localStorage on this device.

const TOKEN_KEY = "corysdollar.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: stays logged in only for this page load */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: { path: string; message: string }[]) {
    super(message);
  }
}

// This browser's own random id, kept in localStorage: signing in again here reuses the same row in
// Settings › Security › Signed-in devices instead of adding one per sign-in
let memoryDeviceId: string | null = null;
function deviceId() {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    let id = localStorage.getItem("zsb-device-id");
    if (!id) {
      id = make();
      localStorage.setItem("zsb-device-id", id);
    }
    return id;
  } catch {
    return (memoryDeviceId ??= make());
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { "x-device-id": deviceId(), ...extraHeaders };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    setToken(null);
    window.dispatchEvent(new Event("zerosmartbudget:logout"));
  }
  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.details);
  return data as T;
}

// ---------- shapes returned by the API ----------

export interface IncomeLine {
  id: number;
  name: string;
  sortOrder: number;
  plannedCents: number;
  receivedCents: number;
  rolloverFrom?: number | null; // "Rollover from September": set by that month's Month Close
}

export interface BudgetLine {
  id: number;
  name: string;
  sortOrder: number;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  sinkingFund: { id: number; name: string; kind: "sinking" | "goal"; targetCents: number | null; balanceCents: number; goalReached: boolean } | null;
  favorite: boolean;
}

export interface BudgetGroup {
  id: number;
  name: string;
  sortOrder: number;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  items: BudgetLine[];
}

export interface BudgetTotals {
  incomePlannedCents: number;
  incomeReceivedCents: number;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  leftToBudgetCents: number;
}

export interface Budget {
  exists: true;
  id: number;
  year: number;
  month: number;
  income: IncomeLine[];
  groups: BudgetGroup[];
  totals: BudgetTotals;
  close: MonthCloseState;
}

// ---------- Month Close ----------

export interface MonthCloseResult {
  totalCents: number; // + under budget, - over
  leftover?: { to: "fund" | "rollover" | "keep"; fundId?: number; fundName?: string; amountCents: number; keptCents: number };
  overspent?: { to: "fund" | "keep"; fundId?: number; fundName?: string; amountCents: number; uncoveredCents: number };
}

export interface MonthCloseState {
  closed: boolean;
  closedAt: string | null;
  closedBy: "you" | "auto" | null;
  available: boolean; // show the Month Close banner
  result: MonthCloseResult | null;
  changedSinceClose: boolean;
}

export interface CloseLine {
  id: number;
  name: string;
  group: string;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
}

export interface MonthClosePreview {
  id: number;
  year: number;
  month: number;
  name: string; // "September 2026"
  nextName: string;
  nextExists: boolean;
  closed: boolean;
  closedBy: "you" | "auto" | null;
  result: MonthCloseResult | null;
  uncategorized: number;
  moneyLeft: CloseLine[];
  overspent: CloseLine[];
  fundItems: { id: number; name: string; fundName: string; remainingCents: number }[];
  income: { plannedCents: number; receivedCents: number };
  leftToBudgetCents: number;
  totalCents: number;
  funds: { id: number; name: string; kind: "sinking" | "goal"; targetCents: number | null; balanceCents: number; goalReached: boolean; roomCents: number | null }[];
}

export type CloseChoice = {
  leftover?: { to: "fund"; fundId: number } | { to: "rollover" } | { to: "keep" };
  overspent?: { to: "fund"; fundId: number } | { to: "keep" };
};

export interface MissingMonth {
  exists: false;
  year: number;
  month: number;
  canCopyFrom: { year: number; month: number } | null;
  waitingTransactions?: number; // already in this month (e.g. imported from a bank)
}

export type MonthResponse = Budget | MissingMonth;

export interface TransactionSplit {
  id: number;
  lineItemId: number | null;
  incomeItemId: number | null;
  amountCents: number;
  itemName?: string | null; // name of the item it's assigned to (any month)
}

export interface Transaction {
  id: number;
  date: string; // YYYY-MM-DD
  merchant: string;
  amountCents: number;
  type: "expense" | "income";
  note: string | null;
  splits: TransactionSplit[];
  // For unassigned transactions: the item this merchant went to last time (if any)
  suggestion?: Suggestion | null;
  // The AI's guess, only when history has none (shown in purple)
  aiSuggestion?: (Suggestion & { reason?: string; model: string; service?: string }) | null;
  checkNumber?: string | null;
  originalDescription?: string | null; // the bank's own wording, shown under the merchant
  plaidAccountId?: string | null;
  // In the Deleted tab (can be restored)
  deletedAt?: string | null;
  // Imported from a bank through Plaid
  pending?: boolean;
  account?: { name: string; mask: string | null } | null;
}

export interface Suggestion {
  lineItemId?: number;
  incomeItemId?: number;
  itemName: string;
  groupName: string;
}

export interface TransactionInput {
  date: string;
  merchant: string;
  amountCents: number;
  type: "expense" | "income";
  note?: string | null;
  checkNumber?: string | null;
  plaidAccountId?: string | null;
  splits: { lineItemId?: number; incomeItemId?: number; amountCents: number }[];
}

export interface GoalPlan {
  neededCents: number;
  monthsLeft: number | null;
  monthlyCents: number | null; // to reach it by its date
  overdue: boolean;
}

export interface SinkingFund {
  id: number;
  name: string;
  kind: "sinking" | "goal"; // a goal stops at its target
  targetCents: number | null;
  targetDate: string | null; // goals: YYYY-MM-01
  startingBalanceCents: number;
  archived: boolean;
  contributedCents: number;
  spentCents: number;
  adjustmentsCents: number;
  monthCloseCents: number; // put in / taken out at Month Close
  balanceCents: number;
  goalReached: boolean;
  plan: GoalPlan | null;
}

export interface FundEntry {
  id: number;
  kind: "budgeted" | "spent" | "adjustment" | "month_close";
  date: string;
  amountCents: number;
  description: string | null;
  lineItemId: number | null;
  transactionId: number | null;
  live: boolean; // follows a linked budget item (can't be deleted here)
}

// Download a file from the API (needs the login header, so a plain link won't do)
export async function downloadFile(path: string) {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

// " Waiting for a budget: June 2026 (14), July 2026 (16)." for bank sync messages
export function waitingNote(waiting: { year: number; month: number; count: number }[] | undefined) {
  if (!waiting?.length) return "";
  const name = (w: { year: number; month: number }) => new Date(w.year, w.month - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const list = waiting.map((w) => `${name(w)} (${w.count})`).join(", ");
  return ` Waiting for a budget: ${list}. Create ${waiting.length === 1 ? "that month" : "those months"} to see them.`;
}
