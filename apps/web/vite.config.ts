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
      // Routes not yet ported out of server.js (Moxfield import, password reset, Google sign-in) are
      // called through this prefix — see legacyUrl() in src/lib/apiClient.ts. The prefix is stripped so
      // the legacy server still sees its own /api/... paths.
      "/legacy-api": {
        target: process.env.VITE_LEGACY_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/legacy-api/, ""),
      },
    },
  },
})
