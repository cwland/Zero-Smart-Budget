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
      "Settings › Logs: emails sent, AI and bank sync problems, refused API requests and scheduled tasks (backups, bank sync, notifications) in one list, with filters.",
      "Signed-in devices with per-device sign out, and sign-in history for the last 60 days.",
      "API keys now have an access type: Read only, Add transactions, or both. No key can change your plan or settings.",
      "Backups include your settings. Saved keys and passwords are encrypted with BACKUP_KEY, and a restore can use another server's key.",
      "AI: each service is checked when you save it; AI is turned on and off in Settings › Budget only; backup AI services take over when one is down.",
      "Email: an on/off switch, a Send test email pop-up, and notifications (Wrap-Up reminder, come-back nudge).",
      "Month Wrap-Up, savings goals with a target date, and an Accounts page with manual accounts and assets for net worth.",
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
