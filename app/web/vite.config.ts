import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The API and the SPA are same-origin in production (Caddy serves web/dist and
// reverse-proxies /api/* and /healthz to the Fastify process). The dev proxy
// reproduces that so session cookies, which are SameSite=Lax, keep working.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3100";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/healthz": { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    // Character art and fonts are already compressed; inlining would only
    // bloat the JS bundle and defeat their separate cache lifetimes.
    assetsInlineLimit: 0,
  },
});
