import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    // Node environment: these are transport and cache-key tests, not component tests, so there is no
    // reason to pull in a DOM implementation.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
