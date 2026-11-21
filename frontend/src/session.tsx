import { createContext, useContext } from "react";

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  seenVersion?: string | null; // the version whose "What's new" was dismissed
  theme?: string | null; // Settings › Profile › Theme (null: the default)
  role?: "owner" | "admin" | "user"; // shared access (see backend/src/lib/roles.ts)
  tossAnimation?: boolean; // this person's own setting (Settings › Budget)
}

/** Can change the app's setup (everyone but a "user") */
export const canManage = (u: User) => u.role !== "user";

export interface Session {
  user: User;
  setUser: (u: User) => void;
  // Store a fresh login token (after a password change, the old one stops working)
  replaceToken: (token: string) => void;
  signOut: () => void;
  signOutEverywhere: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionContext");
  return s;
}

// "Alex Rivera" -> "AR"; a single word like "alex" -> "AL"
export const initialsOf = (u: User) => {
  const words = (u.displayName?.trim() || u.username).split(/\s+/).filter(Boolean);
  const text = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return text.toUpperCase();
};
