import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * E2E du système de mises à jour (page /updates).
 *
 * L'API est stubée par interception : relié à la fois /api/updates/check,
 * /api/updates/history, /api/updates/apply, etc. — aucun service réel requis.
 *
 * Flows couverts : toggle bêta, état « vous êtes à jour », pipeline live dans
 * la carte (verrouillage du reste de la page), verdict, installation d'une
 * version intermédiaire, historique, rollback, garde non-owner.
 */

const OWNER = { id: "owner-1", email: "owner@hbox.local", role: "owner", mfaEnabled: true }

const CHECK_200 = {
  currentVersion: "1.2.2",
  updateChannel: "stable",
  updateAvailable: true,
  latestVersion: "1.2.3",
  latest: { tag: "v1.2.3", version: "1.2.3", publishedAt: "2026-08-01T00:00:00Z", url: "", notes: "## Corrections" },
  releases: [
    { tag: "v1.2.3", version: "1.2.3", publishedAt: "2026-08-01T00:00:00Z", url: "", notes: "## Corrections" },
    { tag: "v1.2.2", version: "1.2.2", publishedAt: "2026-07-01T00:00:00Z", url: "", notes: "" },
  ],
  lastCheckAt: "2026-08-08T00:00:00Z",
  degraded: null,
  channelHistory: [],
}

/** Aucune mise à jour dispo : état « vous êtes à jour » + zéro bouton. */
const CHECK_UP_TO_DATE = {
  ...CHECK_200,
  updateAvailable: false,
  latestVersion: null,
  latest: null,
}

const RUNNING_UPDATE = {
  id: "update-1",
  status: "running",
  fromVersion: "1.2.2",
  toVersion: "1.2.3",
  channel: "stable",
  steps: [],
  logs: [],
  error: null,
  createdAt: "2026-08-08T00:00:00Z",
}

const PIPELINE_STEPS = [
  { name: "backup", status: "success" },
  { name: "version", status: "success" },
  { name: "pull", status: "running" },
  { name: "web", status: "pending" },
  { name: "api", status: "pending" },
]

type Handler = (route: Route) => void

/** Stub mon-réseau : un SEUL handler par test (les overrides remplacent les défauts). */
async function stubApi(page: Page, overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    "GET /api/auth/me": (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OWNER) }),
    "GET /api/updates/check": (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHECK_200) }),
    "GET /api/updates/history": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], total: 0, hasMore: false }),
      }),
    ...overrides,
  }
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url())
    const key = `${route.request().method()} ${url.pathname}`
    const handler = handlers[key]
    if (!handler) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "non stubé" }) })
    }
    return handler(route)
  })
}

/** Stub commun des tests qui lancent une mise à jour (apply + status).
 *  `getStatus` peut être un objet fixe ou une fonction évaluée à CHAQUE
 *  requête (pour simuler running → success dans le temps). */
function stubApply(page: Page, getStatus: Record<string, unknown> | (() => Record<string, unknown>) = {}) {
  return stubApi(page, {
    "POST /api/updates/apply": (route) =>
      route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "update-1" }) }),
    "GET /api/updates/status/update-1": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...RUNNING_UPDATE,
          ...(typeof getStatus === "function" ? getStatus() : getStatus),
        }),
      }),
  })
}

async function login(page: Page) {
  await page.addInitScript((token) => {
    window.localStorage.setItem("hullbay_token", token)
  }, "e2e-token")
}

async function launchUpdate(page: Page) {
  await page.getByRole("button", { name: "Mettre à jour" }).first().click()
  await page.locator('[role="alertdialog"]').getByRole("button", { name: "Confirmer la mise à jour" }).click()
}

test.beforeEach(async ({ page }) => {
  await login(page)
})

test("affiche la carte d'installation et les versions publiées", async ({ page }) => {
  await stubApi(page)
  await page.goto("/updates")

  await expect(page.getByRole("heading", { name: "Mises à jour" })).toBeVisible()
  // Version courante en gros mono + badge de dispo.
  await expect(page.getByText("1.2.2", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Mise à jour disponible", { exact: true })).toBeVisible()
  await expect(page.getByText("1.2.3").first()).toBeVisible()
  await expect(page.getByText("Corrections").first()).toBeVisible()
  // Toggle bêta présent dans le header, "Vérifier maintenant" masqué.
  await expect(page.getByRole("switch", { name: "Version bêta" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Vérifier maintenant/ })).not.toBeVisible()
  // Bouton de mise à jour visible (une version plus récente existe).
  await expect(page.getByRole("button", { name: "Mettre à jour" }).first()).toBeVisible()
})

test("le badge navbar 'Mises à jour' est présent pour owner et ouvre la page", async ({ page }) => {
  await stubApi(page)
  await page.goto("/")
  await expect(page.getByRole("link", { name: /Mises à jour/ })).toBeVisible()
  await page.getByRole("link", { name: /Mises à jour/ }).click()
  await expect(page.getByRole("heading", { name: "Mises à jour" })).toBeVisible()
})

test("le toggle bêta persiste le canal (PUT /api/updates/channel)", async ({ page }) => {
  await stubApi(page, {
    "PUT /api/updates/channel": (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, channel: "beta" }) }),
  })

  await page.goto("/updates")
  await page.getByRole("switch", { name: "Version bêta" }).click()
  await expect(page.getByText("Canal passé en beta")).toBeVisible({ timeout: 15_000 })
})

test("quand le système est à jour : « Vous êtes à jour » et aucun bouton", async ({ page }) => {
  await stubApi(page, {
    "GET /api/updates/check": (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CHECK_UP_TO_DATE) }),
  })

  await page.goto("/updates")
  await expect(page.getByText(/Vous êtes à jour/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Mettre à jour" })).not.toBeVisible()
})

test("l'historique est paginé : filtres et 'Voir plus'", async ({ page }) => {
  const items = Array.from({ length: 45 }, (_, i) => ({
    id: `u-${i}`,
    status: "failed",
    fromVersion: "1.2.1",
    toVersion: "1.2.2",
    channel: "stable",
    steps: [],
    logs: [],
    error: `échec ${i}`,
    createdAt: `2026-08-01T00:00:00Z`,
  }))
  await stubApi(page, {
    "GET /api/updates/history": (route) => {
      const u = new URL(route.request().url())
      const limit = Number(u.searchParams.get("limit")) || 20
      const offset = Number(u.searchParams.get("offset")) || 0
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: items.slice(offset, offset + limit),
          total: items.length,
          hasMore: offset + limit < items.length,
        }),
      })
    },
  })

  await page.goto("/updates")
  await page.getByRole("tab", { name: "Historique" }).click()
  // Une carte par entrée (l'erreur est masquée pour l'instant → on compte).
  // "Voir plus" REMPLACE la page courante (offset croissant), ne cumule pas.
  const entries = page.locator('[data-testid="history-entry"]')
  await expect(entries).toHaveCount(20)
  await expect(page.getByRole("button", { name: /Voir plus/ })).toBeVisible()
  await page.getByRole("button", { name: /Voir plus/ }).click()
  await expect(entries).toHaveCount(20)
  await page.getByRole("button", { name: /Voir plus/ }).click()
  await expect(entries).toHaveCount(5)
  await expect(page.getByRole("button", { name: /Voir plus/ })).not.toBeVisible()
})

test("la confirmation lance l'update et le pipeline live s'affiche dans la carte", async ({ page }) => {
  await stubApply(page, {
    steps: PIPELINE_STEPS,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
  })

  await page.goto("/updates")
  await launchUpdate(page)

  // Toast + carte passée en mode pipeline (titre + stepper visuel).
  await expect(page.getByText("Mise à jour lancée — suivi en direct")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Mise à jour en cours", { exact: true })).toBeVisible()
  await expect(page.getByText("1.2.2 → 1.2.3").first()).toBeVisible()
  await expect(page.getByText("Sauvegarde", { exact: true })).toBeVisible()
  await expect(page.getByText("Images", { exact: true })).toBeVisible()
  // Durée visible.
  await expect(page.getByText(/· 3\d+s/)).toBeVisible()
})

test("pendant l'update, les autres éléments sont désactivés et le rechargement demande confirmation", async ({ page }) => {
  await stubApply(page, {
    steps: PIPELINE_STEPS,
    startedAt: new Date(Date.now() - 65_000).toISOString(),
  })

  await page.goto("/updates")
  await launchUpdate(page)

  // Carte en mode pipeline, page verrouillée : toggle désactivé, boutons inertes.
  await expect(page.getByText("Mise à jour en cours", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("switch", { name: "Version bêta" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Installer cette version" }).first()).toBeDisabled()
  await expect(page.getByText(/· 1m/)).toBeVisible()
  // Aucun log dans le pipeline (retour visuel uniquement).
  await expect(page.getByText("[backup]")).not.toBeVisible()

  // beforeunload actif tant que l'update court : le navigateur demande confirmation.
  const dialogEvent = page.waitForEvent("dialog", { timeout: 10_000 })
  const reloadDone = page.reload({ timeout: 15_000 }).catch(() => {})
  const beforeUnload = await dialogEvent
  expect(beforeUnload.type()).toBe("beforeunload")
  await beforeUnload.accept()
  await reloadDone
})

test("le verdict affiche la fin de la mise à jour (check animé + Recharger/Fermer)", async ({ page }) => {
  let status = "running"
  await stubApply(
    page,
    () => ({
      status,
      steps: [
        { name: "backup", status: "success" },
        { name: "version", status: "success" },
        { name: "pull", status: "success" },
        { name: "web", status: "success" },
        { name: "api", status: "success" },
      ],
      startedAt: new Date(Date.now() - 95_000).toISOString(),
      finishedAt: status === "success" ? new Date().toISOString() : null,
    }),
  )

  await page.goto("/updates")
  await launchUpdate(page)
  await expect(page.getByText("Mise à jour en cours", { exact: true })).toBeVisible({ timeout: 15_000 })

  status = "success"
  const banner = page.getByText("Mise à jour terminée")
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "Recharger la page" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Fermer" })).toBeVisible()

  // Fermer ramène la carte à l'état normal (bouton de mise à jour de retour).
  await page.getByRole("button", { name: "Fermer" }).click()
  await expect(page.getByRole("button", { name: "Mettre à jour" }).first()).toBeVisible()
})

test("une version intermédiaire s'installe depuis la liste des releases", async ({ page }) => {
  await stubApi(page, {
    "POST /api/updates/apply": (route) =>
      route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "update-1" }) }),
    "GET /api/updates/status/update-1": (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNNING_UPDATE) }),
  })

  await page.goto("/updates")
  // Une seule release plus récente que la version courante → un seul bouton.
  const installBtn = page.getByRole("button", { name: "Installer cette version" })
  await expect(installBtn).toHaveCount(1)

  await installBtn.click()
  await expect(page.locator('[role="alertdialog"]').getByText("Version intermédiaire")).toBeVisible()
  await page.locator('[role="alertdialog"]').getByRole("button", { name: "Confirmer la mise à jour" }).click()
  await expect(page.getByText("Mise à jour lancée — suivi en direct")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Mise à jour en cours", { exact: true })).toBeVisible()
})

test("le rollback d'une update réussie demande une confirmation avant de partir", async ({ page }) => {
  await stubApi(page, {
    "GET /api/updates/history": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "u-ok",
              status: "success",
              rolledBack: false,
              rollbackOfId: null,
              fromVersion: "1.2.1",
              toVersion: "1.2.2",
              channel: "stable",
              steps: [],
              logs: [],
              error: null,
              createdAt: "2026-08-07T00:00:00Z",
            },
          ],
          total: 1,
          hasMore: false,
        }),
      }),
    "POST /api/updates/u-ok/rollback": (route) =>
      route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "rb-1", status: "running" }) }),
  })

  await page.goto("/updates")
  await page.getByRole("tab", { name: "Historique" }).click()
  await page.getByRole("button", { name: "Rollback" }).click()
  await expect(page.getByRole("button", { name: "Confirmer le rollback" })).toBeVisible()
  await page.getByRole("button", { name: "Confirmer le rollback" }).click()
  await expect(page.getByText("Rollback lancé")).toBeVisible()
})

test("une update échouée n'a PAS de bouton rollback (rien à annuler)", async ({ page }) => {
  await stubApi(page, {
    "GET /api/updates/history": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "u-failed",
              status: "failed",
              rolledBack: false,
              rollbackOfId: null,
              fromVersion: "1.2.1",
              toVersion: "1.2.2",
              channel: "stable",
              steps: [],
              logs: [],
              error: "boom",
              createdAt: "2026-08-07T00:00:00Z",
            },
            {
              id: "u-rolled",
              status: "success",
              rolledBack: true,
              rollbackOfId: "rb-0",
              fromVersion: "1.2.1",
              toVersion: "1.2.2",
              channel: "stable",
              steps: [],
              logs: [],
              error: null,
              createdAt: "2026-08-06T00:00:00Z",
            },
          ],
          total: 2,
          hasMore: false,
        }),
      }),
  })

  await page.goto("/updates")
  await page.getByRole("tab", { name: "Historique" }).click()
  // Ni l'échec ni le succès déjà annulé ne sont rollbackables.
  await expect(page.getByRole("button", { name: "Rollback" })).toHaveCount(0)
})

test("un non-owner n'a pas accès aux Mises à jour", async ({ page }) => {
  await stubApi(page, {
    "GET /api/auth/me": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "op-1", email: "op@hbox.local", role: "operator", mfaEnabled: true }),
      }),
  })

  await page.goto("/")
  await expect(page.getByRole("link", { name: "Mises à jour" })).not.toBeVisible()
  await page.goto("/updates")
  await expect(page.getByRole("link", { name: "Mises à jour" })).not.toBeVisible()
})
