import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // xfwd: pass the browser's address along, so Signed-in devices shows the real IP
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:4000", xfwd: true },
    },
  },
});
