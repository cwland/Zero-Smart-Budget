// Email colors for each theme (a copy of the frontend themes in frontend/src/themes.ts: keep them in step).
// Emails use the colors of the theme picked in Settings › Profile.

export type EmailThemeId = "harbor" | "midnight-coral" | "plum-amber" | "terracotta-sage" | "slate-rose";

export interface EmailColors {
  "page": string; "line": string; "strong": string; "brand": string; "brand-subtle": string; "success": string; "error": string; "warning": string; "primary": string; "action": string; "link": string; "ink": string; "subtle": string; "muted": string;
}

export const EMAIL_THEMES: Record<EmailThemeId, EmailColors> = {
  "harbor": {"page": "#f4f7f7", "line": "#e3eaea", "strong": "#cfd9d9", "brand": "#14a3a0", "brand-subtle": "#e2f5f4", "success": "#1f9d55", "error": "#d1433b", "warning": "#f2a20c", "primary": "#0d3b45", "action": "#0b7a85", "link": "#0b8fa0", "ink": "#1b2629", "subtle": "#47575b", "muted": "#66777b"}, // Harbor
  "midnight-coral": {"page": "#f5f6fa", "line": "#e6e8f0", "strong": "#d3d7e3", "brand": "#ff6b57", "brand-subtle": "#ffeae6", "success": "#1a9e5c", "error": "#d23c3c", "warning": "#f5a524", "primary": "#1e1b4b", "action": "#4338ca", "link": "#4f46e5", "ink": "#1c1d29", "subtle": "#4a4d61", "muted": "#6b6f85"}, // Midnight & Coral
  "plum-amber": {"page": "#f7f5f8", "line": "#ebe6ee", "strong": "#dad2df", "brand": "#f0a500", "brand-subtle": "#fdf3dc", "success": "#2e9e5b", "error": "#cf3e4a", "warning": "#e8930c", "primary": "#3d1f4f", "action": "#7b3fa0", "link": "#8e4bb8", "ink": "#241c28", "subtle": "#534858", "muted": "#74687a"}, // Plum & Amber
  "terracotta-sage": {"page": "#f8f5f2", "line": "#ece5de", "strong": "#ddd2c7", "brand": "#6f9f7c", "brand-subtle": "#e7f1ea", "success": "#3f8f5a", "error": "#c23b2e", "warning": "#e09a1f", "primary": "#3e2a22", "action": "#b4532a", "link": "#c2410c", "ink": "#2a211d", "subtle": "#5b4d46", "muted": "#7a6c64"}, // Terracotta & Sage
  "slate-rose": {"page": "#f5f6f8", "line": "#e5e7ec", "strong": "#d1d5dd", "brand": "#f43f5e", "brand-subtle": "#ffe4e8", "success": "#16a34a", "error": "#dc2626", "warning": "#f59e0b", "primary": "#2b2d42", "action": "#be185d", "link": "#db2777", "ink": "#1f2130", "subtle": "#4b4f63", "muted": "#6b7083"}, // Slate & Rose
};

export const emailColors = (theme: string | null | undefined): EmailColors => EMAIL_THEMES[(theme ?? "harbor") as EmailThemeId] ?? EMAIL_THEMES.harbor;
