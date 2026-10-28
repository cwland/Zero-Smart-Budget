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

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    setToken(null);
    window.dispatchEvent(new Event("corysdollar:logout"));
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
}

export interface BudgetLine {
  id: number;
  name: string;
  sortOrder: number;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  sinkingFund: { id: number; name: string; targetCents: number | null; balanceCents: number } | null;
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
}

export interface MissingMonth {
  exists: false;
  year: number;
  month: number;
  canCopyFrom: { year: number; month: number } | null;
}

export type MonthResponse = Budget | MissingMonth;

export interface TransactionSplit {
  id: number;
  lineItemId: number | null;
  incomeItemId: number | null;
  amountCents: number;
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
  splits: { lineItemId?: number; incomeItemId?: number; amountCents: number }[];
}

export interface SinkingFund {
  id: number;
  name: string;
  targetCents: number | null;
  startingBalanceCents: number;
  archived: boolean;
  contributedCents: number;
  spentCents: number;
  adjustmentsCents: number;
  balanceCents: number;
}

export interface FundEntry {
  id: number;
  kind: "budgeted" | "spent" | "adjustment";
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
