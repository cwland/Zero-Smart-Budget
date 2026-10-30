// Shared access: who can do what. Everyone shares one budget.
//  - owner: the account that set the server up. Everything, including Shared access (inviting people).
//  - admin: everything the owner can, except Shared access.
//  - user: uses the budget, transactions, accounts and reports, and changes their own profile,
//    security, toss animation and notifications. The server's setup (email, Plaid, AI, API keys,
//    data and backups, logs, budget preferences, adding or removing accounts) is off limits.

export type Role = "owner" | "admin" | "user";
export const ROLES: Role[] = ["owner", "admin", "user"];
export const asRole = (r: string | null | undefined): Role => (r === "owner" || r === "admin" ? r : "user");

// Routes only the owner can use (Shared access)
const OWNER_ONLY = [/^\/api\/users(\/|$)/];

// Routes a user can't use. Matched against "METHOD /path" (the route pattern, e.g. /api/keys/:id).
const USER_BLOCKED = [
  /^\w+ \/api\/keys(\/|$)/, // API keys
  /^\w+ \/api\/logs(\/|$)/, // Logs
  /^\w+ \/api\/backups(\/|$)/, // Data: backups
  /^\w+ \/api\/export(\/|$)/, // Data: export
  /^POST \/api\/import$/, // Data: import
  /^\w+ \/api\/dev\//,
  /^\w+ \/api\/settings\/(email|plaid|ai|oauth)(\/|$)/, // Email, Plaid, AI and sign-in settings
  /^PUT \/api\/settings\/features$/, // turning whole features on and off
  /^(POST|PATCH|DELETE) \/api\/accounts\/manual/, // adding, changing and removing accounts
  /^POST \/api\/plaid\/(link-token|exchange)$/, // connecting a bank
  /^(PATCH|DELETE) \/api\/plaid\/(items|accounts)\//, // changing or removing a bank connection
  /^(POST|PUT) \/api\/updates\/(check|settings)$/, // app updates
];

export function roleAllows(role: Role, method: string, path: string) {
  if (role === "owner") return true;
  if (OWNER_ONLY.some((r) => r.test(path))) return false;
  if (role === "admin") return true;
  const route = `${method} ${path}`;
  return !USER_BLOCKED.some((r) => r.test(route));
}

export const roleDenied = (role: Role) =>
  role === "admin" ? "Only the account owner can manage shared access" : "Your account can't change this. Ask the account owner.";

/** Can change the server's setup and budget preferences */
export const canManage = (role: Role | undefined) => role === "owner" || role === "admin";
