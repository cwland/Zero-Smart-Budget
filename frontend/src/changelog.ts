// "What's new": one entry per version, newest first. Add an entry (and bump "version" in
// package.json) with each release; everyone sees it once after signing in, and any time from the
// version number in the bottom left.
export interface Release {
  version: string;
  date: string; // YYYY-MM-DD
  title?: string;
  changes: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: "0.2.0",
    date: "2026-10-29",
    title: "Zero Smart Budget",
    changes: [
      "New name and look: Zero Smart Budget, AI-Powered Zero-Based Budgeting, with open-source icons and our own wording.",
      "Passkeys: sign in with Touch ID, Face ID, Windows Hello or your phone. Add one in Settings › Security; your password still works. 1Password and your browser offer it as soon as the sign-in page opens.",
      "Sign in with OAuth / OpenID Connect (Authentik, Keycloak, Google…): set it up in Settings › Security, link your account, and optionally turn password sign-in off. If you're ever locked out, npm run auth:reset turns passwords back on.",
      "Settings › Logs: emails sent, AI and bank sync problems, refused API requests and scheduled tasks (backups, bank sync, notifications) in one list, with filters.",
      "Signed-in devices (one row per browser) with per-device sign out, and sign-in history for the last 60 days.",
      "Your email address is now required in Settings › Profile (password reset links and notifications go there).",
      "API keys now have an access type: Read only, Add transactions, or both. No key can change your plan or settings.",
      "Backups include your settings. Saved keys and passwords are encrypted with BACKUP_KEY, and a restore can use another server's key.",
      "AI: each service is checked when you save it; choose when it's used in Settings › Budget; backup AI services take over when one is down.",
      "On/off switches for Plaid, AI and API keys at the top of their Settings tabs. Off hides the settings and stops the feature (no bank syncing, no AI, every API key refused) but keeps your keys, banks and services for later.",
      "Email: an on/off switch, a Send test email pop-up, and notifications (Wrap-Up reminder, come-back nudge).",
      "Month Wrap-Up, savings goals with a target date, and an Accounts page with manual accounts and assets (counted in your total balance).",
      "Accounts: click an account to open its details on the side, under your Total Balance, where you can turn importing its transactions on or off.",
      "A bar at the top tells you when a newer version is released on GitHub, with its notes a click away. Dismiss it until the next one, or turn it off in Settings › Data › Updates.",
      "New look: five color themes (Harbor, Midnight & Coral, Plum & Amber, Terracotta & Sage, Slate & Rose). Pick one in Settings › Profile › Theme.",
      "New months made from suggested categories start with a fresh set of groups (Home, Food, Getting Around, Bills & Subscriptions…).",
      "Signing in always opens this month's budget. The version number (bottom left) shows these notes again.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-10-27",
    title: "First version",
    changes: [
      "A zero-based budget for each month: income, groups and items, planned versus spent, and copying a previous month.",
      "Transactions: add them yourself or sync them from your bank through Plaid; split them across items; Quick Assign suggests items from past spending.",
      "AI suggestions for transactions with no history to learn from.",
      "Sinking funds, exports (JSON and CSV) and daily backups.",
      "One account with a password, and API keys for other apps.",
    ],
  },
];

// "0.10.0" > "0.9.2"
export function isNewer(a: string, b: string | null | undefined) {
  if (!b) return true;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
