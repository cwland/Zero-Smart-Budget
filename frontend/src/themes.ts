import { useEffect, useState } from "react";

// Color themes (Settings › Profile › Theme). Each one sets the color tokens from index.css
// (--color-*) and the group colors for the chart. The choice is saved with your account and
// remembered in this browser, so the sign-in page uses it too.

export type ThemeId = "harbor" | "midnight-coral" | "plum-amber" | "terracotta-sage" | "slate-rose";

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  colors: Record<string, string>; // --color-<name>
  groups: string[]; // group colors, in order
}

export const THEMES: Theme[] = [
  {
    id: "harbor",
    name: "Harbor",
    description: "Deep teal with a bright teal logo",
    colors: { page: "#f4f7f7", line: "#e3eaea", strong: "#cfd9d9", brand: "#14a3a0", "brand-subtle": "#e2f5f4", success: "#1f9d55", "success-subtle": "#dcf5e5", error: "#d1433b", "error-subtle": "#fde2df", warning: "#f2a20c", pressed: "#e8f4f4", active: "#d2eeee", primary: "#0d3b45", "primary-pressed": "#082a31", action: "#0b7a85", link: "#0b8fa0", ink: "#1b2629", subtle: "#47575b", muted: "#66777b", inactive: "#8fa0a3" },
    groups: ["#0b7a85", "#f2a20c", "#e0604f", "#5b6cc7", "#1f9d55", "#c2549b", "#3aa7c9", "#9a7b2f", "#7a5cc0", "#8fa0a3", "#2f5d62", "#e8875b"],
  },
  {
    id: "midnight-coral",
    name: "Midnight & Coral",
    description: "Midnight indigo, violet and a coral logo",
    colors: { page: "#f5f6fa", line: "#e6e8f0", strong: "#d3d7e3", brand: "#ff6b57", "brand-subtle": "#ffeae6", success: "#1a9e5c", "success-subtle": "#dcf6e7", error: "#d23c3c", "error-subtle": "#fde1e1", warning: "#f5a524", pressed: "#eef0fb", active: "#dfe3fb", primary: "#1e1b4b", "primary-pressed": "#13113a", action: "#4338ca", link: "#4f46e5", ink: "#1c1d29", subtle: "#4a4d61", muted: "#6b6f85", inactive: "#9295a8" },
    groups: ["#4f46e5", "#ff6b57", "#f5a524", "#14b8a6", "#a855f7", "#0ea5e9", "#e11d74", "#65a30d", "#64748b", "#f97316", "#1e1b4b", "#94a3b8"],
  },
  {
    id: "plum-amber",
    name: "Plum & Amber",
    description: "Deep plum, purple and an amber logo",
    colors: { page: "#f7f5f8", line: "#ebe6ee", strong: "#dad2df", brand: "#f0a500", "brand-subtle": "#fdf3dc", success: "#2e9e5b", "success-subtle": "#def5e7", error: "#cf3e4a", "error-subtle": "#fbe0e3", warning: "#e8930c", pressed: "#f3edf6", active: "#ead9f2", primary: "#3d1f4f", "primary-pressed": "#2a1338", action: "#7b3fa0", link: "#8e4bb8", ink: "#241c28", subtle: "#534858", muted: "#74687a", inactive: "#9d93a2" },
    groups: ["#7b3fa0", "#f0a500", "#e2546b", "#2a9d8f", "#4c6ef5", "#c0662b", "#b07cc6", "#5aa469", "#d68fb0", "#9d93a2", "#3d1f4f", "#e8930c"],
  },
  {
    id: "terracotta-sage",
    name: "Terracotta & Sage",
    description: "Espresso brown, terracotta and a sage logo",
    colors: { page: "#f8f5f2", line: "#ece5de", strong: "#ddd2c7", brand: "#6f9f7c", "brand-subtle": "#e7f1ea", success: "#3f8f5a", "success-subtle": "#e0f1e5", error: "#c23b2e", "error-subtle": "#f9e0dc", warning: "#e09a1f", pressed: "#f5ece4", active: "#f0dfd1", primary: "#3e2a22", "primary-pressed": "#2b1d17", action: "#b4532a", link: "#c2410c", ink: "#2a211d", subtle: "#5b4d46", muted: "#7a6c64", inactive: "#a1948c" },
    groups: ["#b4532a", "#6f9f7c", "#e09a1f", "#5a7fa6", "#a65f8c", "#3f8f5a", "#d9825b", "#8a7a3a", "#7d6bb0", "#a1948c", "#3e2a22", "#c9a227"],
  },
  {
    id: "slate-rose",
    name: "Slate & Rose",
    description: "Cool slate, rose pink and a rose logo",
    colors: { page: "#f5f6f8", line: "#e5e7ec", strong: "#d1d5dd", brand: "#f43f5e", "brand-subtle": "#ffe4e8", success: "#16a34a", "success-subtle": "#dcfce7", error: "#dc2626", "error-subtle": "#fee2e2", warning: "#f59e0b", pressed: "#f1f2f6", active: "#fde4ea", primary: "#2b2d42", "primary-pressed": "#1c1d2c", action: "#be185d", link: "#db2777", ink: "#1f2130", subtle: "#4b4f63", muted: "#6b7083", inactive: "#9a9eae" },
    groups: ["#be185d", "#2b2d42", "#f59e0b", "#0891b2", "#8b5cf6", "#16a34a", "#f43f5e", "#64748b", "#ea580c", "#9a9eae", "#0f766e", "#c026d3"],
  },
];

export const DEFAULT_THEME: ThemeId = "harbor";
export const themeById = (id: string | null | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0];

const STORE_KEY = "zsb-theme";
let current: Theme = themeById(readStored());
const listeners = new Set<(t: Theme) => void>();

function readStored() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function favicon(brand: string) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${brand}"/><ellipse cx="16" cy="16" rx="7" ry="9" fill="none" stroke="#fff" stroke-width="3.2"/><circle cx="16" cy="16" r="2.4" fill="#fff"/></svg>`)}`;
}

/** Use a theme now (and remember it in this browser). */
export function applyTheme(id: string | null | undefined) {
  current = themeById(id);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(current.colors)) root.setProperty(`--color-${k}`, v);
  try {
    localStorage.setItem(STORE_KEY, current.id);
  } catch {
    /* private window: just this visit */
  }
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = favicon(current.colors.brand);
  listeners.forEach((l) => l(current));
}

export const currentTheme = () => current;

/** The theme in use; re-renders when it changes. */
export function useTheme() {
  const [t, setT] = useState(current);
  useEffect(() => {
    listeners.add(setT);
    setT(current);
    return () => void listeners.delete(setT);
  }, []);
  return t;
}
