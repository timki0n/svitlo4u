import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * In production the core serves this build from the same origin. In development the API (and the
 * SSE stream) is proxied to a running core: the live one by default, or SVITLO_API from the
 * environment or apps/web/.env.local (e.g. a local core: SVITLO_API=http://127.0.0.1:8090).
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env };
  const api = env.SVITLO_API ?? "https://svitlo4u.info";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": { target: api, changeOrigin: true } },
    },
    build: {
      target: "es2022",
      // Every asset as a file: the core's CSP allows fonts and images from 'self' only, not data:.
      assetsInlineLimit: 0,
      // three.js is the heavy part; it loads after the first paint (see Building.tsx).
      chunkSizeWarningLimit: 700,
    },
  };
});
