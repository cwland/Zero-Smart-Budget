// Set from package.json at build time (vite.config.ts)
declare const __APP_VERSION__: string;
export const APP_VERSION: string = __APP_VERSION__;
export const versionLabel = `v${APP_VERSION}`;

// Open "What's new" (the version number anywhere in the app does this)
export const showWhatsNew = () => window.dispatchEvent(new Event("zsb:whats-new"));
