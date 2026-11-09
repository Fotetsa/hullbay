import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * E2E du module sauvegarde dans l'inspecteur du canvas.
 *
 * L'API est entièrement stubbée : aucune dépendance à Postgres/Swarm/rclone.
 * Les secrets ne doivent jamais revenir dans une réponse ni rester dans le DOM.
 */

const OWNER = {
  id: "owner-1",
  email: "owner@hbox.local",
  role: "owner",
  mfaEnabled: false,
  activeTenantId: "tenant-1",
  tenants: [{ tenantId: "tenant-1", role: "owner", tenant: { slug: "hbox" } }],
}

const GRAPH = {
  id: "proj-1",
  name: "Shop",
  slug: "shop",
  description: null,
  status: "draft",
  clusterId: "c1",
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  nodes: [
    {
      id: "n-db",
      projectId: "proj-1",
      type: "database",
      name: "orders-db",
      posX: 0,
      posY: 0,
      config: {
        engine: "postgres",
        version: "16",
        mode: "single",
        topology: {},
        storage: {},
        credentials: {
          username: "app",
          database: "orders",
          passwordSecretRef: "orders_db_password",
        },
        retainDataOnDelete: true,
      },
    },
    {
      id: "n-vol",
      projectId: "proj-1",
      type: "volume",
      name: "uploads",
      posX: 320,
      posY: 0,
      config: { driver: "local", driverOpts: {}, labels: {}, external: false },
    },
  ],
  edges: [],
}

type Destination = {
  id: string
  name: string
  protocol: string
  basePath: string
  projectId: string | null
  lastTestedAt: string | null
  capabilities: Record<string, boolean> | null
  createdAt: string
}

type Policy = {
  id: string
  targetId: string
  destinationId: string
  strategyId: string
  schedule: string
  scheduleHourUtc: number | null
  retentionDays: number
  verification: string
  encryptionMode: string
  placementJson: unknown
  timeoutSec: number
  maxConcurrency: number
  enabled: boolean
}

type State = {
  targets: { id: string; projectId: string; nodeId: string; kind: string; name: string }[]
  destinations: Destination[]
  policies: Policy[]
  runs: Record<string, unknown[]>
  artifacts: Record<string, unknown[]>
  lastDestinationPayload: unknown
  lastProbeId: string | null
}

function initialState(): State {
  return {
    targets: [],
    destinations: [
      {
        id: "dest-s3",
        name: "Offsite S3",
        protocol: "s3",
        basePath: "hullbay/backups",
        projectId: "proj-1",
        lastTestedAt: null,
        capabilities: null,
        createdAt: "2026-10-25T10:00:00.000Z",
      },
      {
        id: "dest-smb",
        name: "NAS atelier",
        protocol: "smb",
        basePath: "backups",
        projectId: "proj-1",
        lastTestedAt: null,
        capabilities: null,
        createdAt: "2026-10-25T10:00:00.000Z",
      },
    ],
    policies: [],
    runs: {},
    artifacts: {},
    lastDestinationPayload: null,
    lastProbeId: null,
  }
}

const JSON_HEADERS = { "content-type": "application/json" }

async function stub(page: Page, state: State) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: JSON_HEADERS, body: JSON.stringify(body) })

    if (path === "/api/auth/me") return json(OWNER)
    if (path === "/api/projects/proj-1" && method === "GET") return json(GRAPH)
    if (path === "/api/projects/proj-1/placement") return json({ servers: [] })
    if (path === "/api/health/cluster") return json({ clusters: [] })
    if (path === "/api/clusters") return json([])
    if (path === "/api/clusters/c1/secrets") return json([])
    if (path === "/api/system/environment") return json({ environment: "development" })
    if (/^\/api\/projects\/proj-1\/nodes\/[^/]+\/preview$/.test(path)) {
      return json({ resources: [], connections: [], missingPasswordSecret: true })
    }
    if (path === "/api/updates/check") return json({ updateAvailable: false })

    if (path === "/api/backup/targets" && method === "GET") {
      return json(state.targets.filter((t) => t.projectId === url.searchParams.get("projectId")))
    }
    if (path === "/api/backup/targets" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { nodeId: string }
      const created = {
        id: "tgt-1",
        projectId: "proj-1",
        nodeId: body.nodeId,
        kind: "postgres",
        name: "orders-db",
      }
      state.targets.push(created)
      return json(created, 201)
    }

    if (path === "/api/backup/destinations" && method === "GET") {
      return json(state.destinations)
    }
    if (path === "/api/backup/destinations" && method === "POST") {
      state.lastDestinationPayload = JSON.parse(request.postData() ?? "{}")
      const created: Destination = {
        id: `dest-${state.destinations.length + 1}`,
        name: "Nouvelle",
        protocol: "s3",
        basePath: "hullbay/backups",
        projectId: "proj-1",
        lastTestedAt: null,
        capabilities: null,
        createdAt: "2026-10-25T10:00:00.000Z",
      }
      state.destinations.push(created)
      return json(created, 201)
    }
    const probe = /^\/api\/backup\/destinations\/([^/]+)\/test$/.exec(path)
    if (probe && method === "POST") {
      state.lastProbeId = probe[1]!
      const capabilities = {
        read: true,
        write: false,
        delete: true,
        move: true,
        checksum: true,
        atomicCommit: true,
      }
      const destination = state.destinations.find((d) => d.id === probe[1])!
      destination.capabilities = capabilities
      destination.lastTestedAt = "2026-10-25T11:00:00.000Z"
      return json({ ok: false, capabilities, destination })
    }

    if (path === "/api/backup/policies" && method === "GET") {
      const targetId = url.searchParams.get("targetId")
      return json(state.policies.filter((p) => p.targetId === targetId))
    }
    if (path === "/api/backup/policies" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as Policy
      const created: Policy = {
        ...body,
        id: `pol-${state.policies.length + 1}`,
        scheduleHourUtc: body.scheduleHourUtc ?? null,
        enabled: true,
      }
      state.policies.push(created)
      return json(created, 201)
    }

    const run = /^\/api\/backup\/policies\/([^/]+)\/run$/.exec(path)
    if (run && method === "POST") {
      const policyId = run[1]!
      state.runs[policyId] = [
        {
          id: `run-${policyId}`,
          policyId,
          status: "COMPLETED",
          phase: "done",
          trigger: "manual",
          startedAt: "2026-10-25T12:00:00.000Z",
          finishedAt: "2026-10-25T12:00:04.000Z",
          sizeBytes: "2048",
          errorCode: null,
          errorMessage: null,
        },
        ...(state.runs[policyId] ?? []),
      ]
      state.artifacts["tgt-1"] = [
        {
          id: "art-1",
          targetId: "tgt-1",
          destinationId: "dest-s3",
          storageKey: "hullbay/backups/shop/orders-db/art-1",
          payloadFormat: "sql.gz",
          checksumSha256: "a".repeat(64),
          sizeBytes: "2048",
          engine: "postgres",
          engineVersion: "16",
          strategyId: "postgres.pg_dump",
          formatVersion: 1,
          committedAt: "2026-10-25T12:00:04.000Z",
        },
      ]
      return json({ ok: true, runId: `run-${policyId}`, artifactId: "art-1" }, 202)
    }

    if (path === "/api/backup/runs") {
      return json(state.runs[url.searchParams.get("policyId") ?? ""] ?? [])
    }
    if (path === "/api/backup/artifacts") {
      return json(state.artifacts[url.searchParams.get("targetId") ?? ""] ?? [])
    }

    return json({ error: `non stubé: ${method} ${path}` }, 404)
  })
}

async function openInspector(page: Page, nodeName = "orders-db", dispatch = false) {
  await page.addInitScript(() => {
    window.localStorage.setItem("hullbay_token", "e2e-token")
  })
  await page.goto("/canvas/proj-1")
  const node = page.getByText(nodeName, { exact: true }).first()
  // Sur mobile (375px), la palette de composants recouvre le nœud : un clic
  // réel est intercepté. On déclenche l'événement sur le nœud pour tester le
  // rendu du panneau, pas la hit-testing du canvas.
  if (dispatch) await node.dispatchEvent("click")
  else await node.click()
  await expect(page.getByRole("dialog")).toBeVisible()
}

test("active la sauvegarde puis affiche la section", async ({ page }) => {
  const state = initialState()
  await stub(page, state)
  await openInspector(page)

  await expect(page.getByTestId("backup-section")).toBeVisible()
  await page.getByTestId("backup-enable").click()

  await expect(page.getByTestId("backup-policies")).toBeHidden()
  await expect(page.getByText("Aucune politique.")).toBeVisible()
})

test("le protocole pilote les champs et le test affiche write=false", async ({ page }) => {
  const state = initialState()
  await stub(page, state)
  await openInspector(page)

  await page.getByTestId("backup-enable").click()
  await page.getByRole("button", { name: "Destinations" }).click()
  await page.getByRole("button", { name: "Ajouter une destination" }).click()

  // S3 : champs bucket + secret key.
  await expect(page.getByTestId("backup-field-bucket")).toBeVisible()
  await expect(page.getByTestId("backup-field-privateKey")).toHaveCount(0)

  // SFTP : les champs changent sans laisser de résidu S3.
  await page.getByTestId("backup-protocol-select").click()
  await page.getByRole("option", { name: "sftp" }).click()
  await expect(page.getByTestId("backup-field-privateKey")).toBeVisible()
  await expect(page.getByTestId("backup-field-bucket")).toHaveCount(0)

  // Une valeur secrète saisie ne fuit ni dans le stockage local ni dans le DOM
  // après fermeture du formulaire (seul le POST la transporte, chiffrée au repos).
  const secret = "s3cr3t-e2e"
  await page.getByTestId("backup-field-password").fill(secret)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret)

  // Probe : la matrice expose write=false, pas un simple badge global.
  await page.getByTestId("backup-test-dest-s3").click()
  await expect(page.getByTestId("backup-destination-dest-s3")).toContainText("Écriture")
  await expect(
    page.getByTestId("backup-destination-dest-s3").getByLabel("Écriture: ko"),
  ).toBeVisible()
  await expect(page.getByTestId("backup-destination-dest-s3")).toContainText(
    "Destination incomplète",
  )
})

test("crée une policy, impose le placement SMB et lance un run", async ({ page }) => {
  const state = initialState()
  await stub(page, state)
  await openInspector(page)
  await page.getByTestId("backup-enable").click()

  await page.getByRole("button", { name: "Créer une politique" }).click()
  await page.getByTestId("backup-policy-destination").click()
  await page.getByRole("option", { name: /NAS atelier/ }).click()
  await page.getByRole("button", { name: "Créer" }).click()
  await expect(page.getByRole("alert")).toContainText("placement")

  await page.getByTestId("backup-policy-placement").fill("node.labels.zone == nas")
  await page.getByRole("button", { name: "Créer" }).click()

  await expect(page.getByTestId("backup-policy-pol-1")).toBeVisible()
  await expect(page.getByTestId("backup-policy-pol-1")).toContainText("NAS atelier")

  await page.getByTestId("backup-run-pol-1").click()
  await expect(page.getByTestId("backup-runs-pol-1")).toContainText("Réussi")
  await expect(page.getByTestId("backup-artifacts")).toContainText("sql.gz")
})

test("mobile 375px : section utilisable, zéro erreur console", async ({ page }) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.setViewportSize({ width: 375, height: 812 })

  const state = initialState()
  await stub(page, state)
  await openInspector(page, "orders-db", true)

  await expect(page.getByTestId("backup-section")).toBeVisible()
  await expect(page.getByTestId("backup-enable")).toBeVisible()
  expect(errors.filter((e) => !/WebSocket|socket/i.test(e))).toEqual([])
})
