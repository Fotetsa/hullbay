import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],

    isolate: true,

    // Les tests d'intégration partagent une base Postgres réelle (seed, tenants,
    // rôles). Les exécuter en parallèle provoque des courses entre fichiers
    // (tenant supprimé pendant un seed → FK violations). On sérialise les
    // fichiers ; les tests d'un même fichier restent séquentiels par défaut.
    fileParallelism: false,

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