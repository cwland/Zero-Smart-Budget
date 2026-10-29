import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// The app version shown on the sign-in screen and under the account button (from package.json)
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      // xfwd: pass the browser's address along, so Signed-in devices shows the real IP
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:4000", xfwd: true },
    },
  },
});
