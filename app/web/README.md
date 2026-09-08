# Web workspace

Vue 3, Vite, Vue Router and Video.js. Run npm -w web run dev from app/; build with npm -w web run build. The dev server proxies API/health to VITE_API_TARGET (loopback 3100 by default). Production Caddy serves dist/ and proxies API/share/health to Fastify.

Self-hosted fonts are in public/fonts/ and character art in src/assets/characters/. Locale bundles cover English, Simplified Chinese, Japanese and Spanish. Current route behavior is implemented in server/src/web/routes/; live state uses SSE and GET refreshes. See ../../INSTALL.md for the complete system setup.
