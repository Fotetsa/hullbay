import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],

    isolate: true,

    reporters: "verbose",

    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/modules/**/*.ts"],
      exclude: ["src/**/__tests__/**"],
    },

    env: {
      NODE_ENV: "test",
    },
  },
});