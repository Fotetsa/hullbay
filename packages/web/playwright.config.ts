import { defineConfig, devices } from "@playwright/test"

/**
 * Tests E2E de l'ops-panel (packages/web).
 *
 * Stratégie : l'API est STUBBÉE par interception réseau (`page.route`) — aucune
 * dépendance à Postgres/Redis/GitHub/Swarm dans le test. Chaque spec fournit
 * les fixtures `/api/**` dont l'URL a besoin et rejette les autres.
 *
 * Lancement : le serveur Vite est démarré automatiquement (webServer).
 *
 * ```
 * npm run e2e                      # web
 * npx playwright test e2e/updates.spec.ts --project=chromium
 * ```
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5273",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Vite dev (port 5273) : le proxy /api est court-circuité par les routes stub.
    command: "npm run dev",
    url: "http://localhost:5273",
    reuseExistingServer: true,
    timeout: 120_000,
  },
})