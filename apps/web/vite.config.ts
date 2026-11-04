import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  base: "/react/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5100,
    proxy: {
      // /api is the v2 API (apps/api). Run it with PORT=4000 so it does not collide with server.js,
      // which still owns port 3000.
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: true,
      },
      // No /socket.io entry on purpose. Proxying the Play Realm socket through here did not carry
      // the WebSocket upgrade reliably (the upgrade was reset before reaching the target), so in
      // development the browser addresses the table server directly via VITE_REALTIME_URL, which
      // `scripts/play.mjs` sets for you. In production one reverse proxy serves both on one origin
      // and that variable is not set at all — see the Caddyfile.
    },
  },
})
