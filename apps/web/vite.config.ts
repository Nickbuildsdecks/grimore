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
      "/api": {
        // The Express server listens on 3000 (server.js), not 5001. The old target made
        // every API call in `npm run dev` fail with connection-refused.
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
})
