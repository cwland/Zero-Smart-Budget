// Opens Plaid Link, Plaid's own window where you sign in to your bank.
// The script comes from Plaid; bank usernames and passwords never touch this app.

const SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface LinkMetadata {
  institution?: { name: string; institution_id: string } | null;
}
interface PlaidGlobal {
  create(config: {
    token: string;
    onSuccess: (publicToken: string, metadata: LinkMetadata) => void;
    onExit: (err: { error_message?: string; display_message?: string } | null) => void;
  }): { open(): void; destroy(): void };
}
declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

let loading: Promise<PlaidGlobal> | null = null;
function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid didn't load")));
    s.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load Plaid. Check your internet connection or ad blocker."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

// Resolves with the public token, or null if the window was closed without connecting
export async function openPlaidLink(linkToken: string): Promise<{ publicToken: string; institutionName?: string } | null> {
  const Plaid = await loadPlaid();
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        resolve({ publicToken, institutionName: metadata.institution?.name });
      },
      onExit: (err) => {
        handler.destroy();
        if (err) reject(new Error(err.display_message || err.error_message || "Plaid closed with an error"));
        else resolve(null);
      },
    });
    handler.open();
  });
}
