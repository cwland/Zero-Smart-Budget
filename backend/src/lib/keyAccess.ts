// What an API key may do. Picked when the key is created (and changeable later):
//  - read:     look at budgets, transactions, funds, goals and accounts
//  - add:      add transactions (and start a bank sync, which also only adds transactions)
//  - read_add: both
// No key can change the budget plan, settings, other keys, or sign-in details.
export const KEY_ACCESS = ["read", "add", "read_add"] as const;
export type KeyAccess = (typeof KEY_ACCESS)[number];

export const KEY_ACCESS_LABELS: Record<KeyAccess, string> = {
  read: "Read only",
  add: "Add transactions",
  read_add: "Read + add transactions",
};

// Never open to a key, even to read: secrets, backups, sign-in and key management
const OFF_LIMITS = ["/api/settings", "/api/keys", "/api/auth", "/api/export", "/api/backups", "/api/plaid", "/api/dev", "/api/profile", "/api/import"];

// The only writes a key can make
const ADD_ROUTES = new Set(["POST /api/transactions", "POST /api/plaid/sync"]);

const canRead = (a: KeyAccess) => a === "read" || a === "read_add";
const canAdd = (a: KeyAccess) => a === "add" || a === "read_add";

// route is the matched route pattern, e.g. "GET /api/transactions/:id"
// Readable even though their area is off limits (bank names and sync status, no secrets)
const READ_EXCEPTIONS = new Set(["/api/plaid/items"]);

export function keyAllows(access: KeyAccess, method: string, path: string): boolean {
  if (method === "GET" && READ_EXCEPTIONS.has(path)) return canRead(access);
  if (ADD_ROUTES.has(`${method} ${path}`)) return canAdd(access);
  if (OFF_LIMITS.some((p) => path === p || path.startsWith(p + "/"))) return false;
  if (method === "GET" || method === "HEAD") return canRead(access);
  return false;
}

export function keyDenied(access: KeyAccess, method: string): string {
  const label = KEY_ACCESS_LABELS[access];
  if (method === "GET" && access === "add") return `This API key can only add transactions (${label})`;
  return `This API key's access (${label}) doesn't allow this`;
}
