import { describe, it, expect, vi } from "vitest"
import { runWorkflow } from "../../lib/workflow"
import { secretsStep, servicesStep } from "../deploy-project"
import type { DeployInput, DeployShared } from "../deploy-project"
import { LabelKeys } from "@hullbay/shared"
import { ImageUnavailableError } from "../../modules/docker-engine/service"

const GENERATED_NAME = "boz_proj-a_postgres-haproxy-a1b2c3d4"

function baseGraph() {
  return {
    id: "p1",
    name: "projet A",
    slug: "proj-a",
    clusterId: "c1",
    status: "draft",
    nodes: [
      {
        id: "n_web",
        projectId: "p1",
        type: "container",
        name: "web",
        posX: 0,
        posY: 0,
        config: { image: "nginx", tag: "1.27", replicas: 1 },
      },
    ],
    edges: [],
  }
}

function fakeEngine(secrets: { name: string; labels?: Record<string, string> }[]) {
  const calls: string[] = []
  return {
    listManagedSecrets: vi.fn(async () =>
      secrets.map((s) => ({ id: s.name, name: s.name, labels: s.labels ?? {} }))
    ),
    upsertSecret: vi.fn(async (name: string, _value: string, labels: Record<string, string>) => {
      calls.push(`upsert:${name}`)
      return name
    }),
    removeSecret: vi.fn(async (name: string) => {
      calls.push(`remove:${name}`)
    }),
    listNodes: vi.fn(async () => []),
    listProjectServices: vi.fn(async () => []),
    calls,
  }
}

function sharedWith(engine: ReturnType<typeof fakeEngine>, generated: { name: string; data: string }[]): DeployShared {
  return {
    log: [],
    networkIdByNodeId: new Map(),
    createdServiceIds: [],
    createdNetworkIds: [],
    createdGateways: [],
    db: { graph: baseGraph() as never, ownership: new Map(), generatedSecrets: generated },
    deployed: new Map(),
    engine: engine as never,
    reconciler: { plan: async () => ({ actions: [] }) } as never,
  }
}

describe("secretsStep — configs générées versionnées, posées AVANT services (S3-04)", () => {
  it("pose le secret généré (nom -hash8) avec les labels de gestion, avant services", async () => {
    const engine = fakeEngine([])
    const shared = sharedWith(engine, [
      { name: GENERATED_NAME, data: "haproxy standby 1\n" },
    ])

    const res = await runWorkflow(
      "t",
      [secretsStep, servicesStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )

    expect(res.ok).toBe(true)
    expect(engine.upsertSecret).toHaveBeenCalledWith(
      GENERATED_NAME,
      expect.any(String),
      expect.objectContaining({
        "bozando.database.generated": "true",
        [LabelKeys.projectId]: "p1",
        [LabelKeys.projectSlug]: "proj-a",
      }),
    )
    expect(shared.log.join("\n")).toContain(`secret généré ${GENERATED_NAME} posé`)
    // ORDRE : listManagedSecrets (secretsStep) → upsertSecret → listNodes (servicesStep).
    const seq = engine.calls
    const listIdx = seq.findIndex((c) => c === "upsert:" + GENERATED_NAME)
    expect(listIdx).toBeGreaterThanOrEqual(0)
    expect(seq.slice(listIdx + 1)).toEqual([]) // aucun createService après (plan vide)
  })

  it("skip idempotent : même nom + labels générés/projet → pas de delete+recreate", async () => {
    const engine = fakeEngine([
      {
        name: GENERATED_NAME,
        labels: {
          "bozando.database.generated": "true",
          [LabelKeys.projectId]: "p1",
          [LabelKeys.projectSlug]: "proj-a",
        },
      },
    ])
    const shared = sharedWith(engine, [{ name: GENERATED_NAME, data: "identique" }])

    const res = await runWorkflow(
      "t",
      [secretsStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(res.ok).toBe(true)
    expect(engine.upsertSecret).not.toHaveBeenCalled()
    expect(shared.log.join("\n")).toContain("inchangé (skip)")
  })

  it("contenu changé → nom neuf créé, ANCIEN secret orphelin retiré", async () => {
    const OLD = "boz_proj-a_postgres-haproxy-fff000ff"
    const engine = fakeEngine([
      {
        name: OLD,
        labels: {
          "bozando.database.generated": "true",
          [LabelKeys.projectId]: "p1",
        },
      },
    ])
    const shared = sharedWith(engine, [{ name: GENERATED_NAME, data: "nouveau" }])

    const res = await runWorkflow(
      "t",
      [secretsStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(res.ok).toBe(true)
    expect(engine.upsertSecret).toHaveBeenCalledWith(
      GENERATED_NAME,
      expect.any(String),
      expect.any(Object),
    )
    expect(engine.removeSecret).toHaveBeenCalledWith(OLD)
    expect(shared.log.join("\n")).toContain(`ancien secret généré ${OLD} supprimé`)
  })

  it("ancien secret ENCORE monté → suppression tolérante (réessai au prochain déploiement)", async () => {
    const OLD = "boz_proj-a_postgres-haproxy-fff000ff"
    const engine = fakeEngine([
      {
        name: OLD,
        labels: {
          "bozando.database.generated": "true",
          [LabelKeys.projectId]: "p1",
        },
      },
    ])
    engine.removeSecret.mockRejectedValueOnce(new Error("secret is in use"))
    const shared = sharedWith(engine, [{ name: GENERATED_NAME, data: "nouveau" }])

    const res = await runWorkflow(
      "t",
      [secretsStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(res.ok).toBe(true)
    expect(shared.log.join("\n")).toContain(`secret ${OLD} retenu (encore monté ?)`)
  })

  it("secrets d'un AUTRE projet → jamais touchés (ni skip ni cleanup)", async () => {
    const other = "boz_other_postgres-haproxy-12345678"
    const engine = fakeEngine([
      {
        name: other,
        labels: {
          "bozando.database.generated": "true",
          [LabelKeys.projectId]: "p2",
        },
      },
    ])
    const shared = sharedWith(engine, [{ name: GENERATED_NAME, data: "x" }])

    await runWorkflow(
      "t",
      [secretsStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(engine.removeSecret).not.toHaveBeenCalled()
    expect(engine.upsertSecret).toHaveBeenCalledTimes(1)
  })
})

describe("servicesStep — garde multi-nœuds : retrait forcé avant « image locale »", () => {
  const GHCR_IMAGE = { image: "ghcr.io/fotetsa/hullbay/patroni", tag: "v4.1.5-pg16" }

  function ghcrGraph() {
    return {
      id: "p1",
      name: "projet A",
      slug: "proj-a",
      clusterId: "c1",
      status: "draft",
      nodes: [
        {
          id: "n_pg",
          projectId: "p1",
          type: "container",
          name: "pg",
          posX: 0,
          posY: 0,
          config: { ...GHCR_IMAGE, replicas: 1 },
        },
      ],
      edges: [],
    }
  }

  function engineWithPull(sequence: { pulled: boolean }[] | "fail") {
    let i = 0
    const ensureImage = vi.fn(async (image: string, policy: string) => {
      expect(image).toBe("ghcr.io/fotetsa/hullbay/patroni:v4.1.5-pg16")
      if (policy === "Always" && sequence === "fail") {
        throw new ImageUnavailableError("Impossible de récupérer l'image")
      }
      const step = Array.isArray(sequence) ? sequence[Math.min(i++, sequence.length - 1)]! : sequence
      return step
    })
    return {
      listNodes: vi.fn(async () => [{ id: "n1" }, { id: "n2" }]), // multi-nœuds
      listProjectServices: vi.fn(async () => []),
      listManagedSecrets: vi.fn(async () => []),
      upsertSecret: vi.fn(async () => "s"),
      removeSecret: vi.fn(async () => {}),
      createService: vi.fn(async () => ({ id: "svc-1" })),
      updateService: vi.fn(async () => {}),
      removeService: vi.fn(async () => {}),
      ensureImage,
    }
  }

  function runWith(engine: ReturnType<typeof engineWithPull>) {
    const shared: DeployShared = {
      log: [],
      networkIdByNodeId: new Map(),
      createdServiceIds: [],
      createdNetworkIds: [],
      createdGateways: [],
      db: { graph: ghcrGraph() as never, ownership: new Map(), generatedSecrets: [] },
      deployed: new Map(),
      engine: engine as never,
      reconciler: {
        plan: async () => ({
          actions: [
            { kind: "create", node: (ghcrGraph() as never)["nodes"]![0] },
          ],
        }),
      } as never,
    }
    return runWorkflow(
      "t",
      [servicesStep],
      { graph: ghcrGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
  }

  it("image en cache local (IfNotPresent, pulled:false) sur multi-nœuds → retry pull forcé accepté", async () => {
    const engine = engineWithPull([{ pulled: false }, { pulled: true }])
    const res = await runWith(engine)
    expect(res.ok).toBe(true)
    // IfNotPresent (cache hit) puis Always (retry) : l'image référencée sur un
    // registre est pullable même si présente localement → deploy continue.
    expect(engine.ensureImage).toHaveBeenCalledWith(
      "ghcr.io/fotetsa/hullbay/patroni:v4.1.5-pg16",
      "IfNotPresent",
    )
    expect(engine.ensureImage).toHaveBeenCalledWith(
      "ghcr.io/fotetsa/hullbay/patroni:v4.1.5-pg16",
      "Always",
    )
    expect(engine.createService).toHaveBeenCalled()
  })

  it("retry pull forcé échoue → DeployError « Impossible de récupérer » (pas d'image locale trompeuse)", async () => {
    const engine = engineWithPull("fail")
    const res = await runWith(engine)
    expect(res.ok).toBe(false)
    expect(engine.createService).not.toHaveBeenCalled()
    expect(String(res.error)).toMatch(/Impossible de récupérer/)
  })

  it("policy déjà Always (pulled:false) + registre injoignable → aucune image locale, erreur directe", async () => {
    const engine = engineWithPull([{ pulled: false }])
    // Force policy Always sur le nœud : le retry retomberait sur Always → on
    // simule que le premier ensureImage a déjà été Always (pulled:false tout de
    // même) ; policy!==Always étant faux, la garde conclut sans re-pull inutile.
    engine.ensureImage.mockClear()
    engine.ensureImage.mockImplementation(async () => ({ pulled: false }))
    const graph = ghcrGraph()
    ;(graph.nodes[0] as { config: Record<string, unknown> }).config.pullPolicy = "Always"
    const shared: DeployShared = {
      log: [],
      networkIdByNodeId: new Map(),
      createdServiceIds: [],
      createdNetworkIds: [],
      createdGateways: [],
      db: { graph: ghcrGraph() as never, ownership: new Map(), generatedSecrets: [] },
      deployed: new Map(),
      engine: engine as never,
      reconciler: {
        plan: async () => ({
          actions: [{ kind: "create", node: graph.nodes[0] }],
        }),
      } as never,
    }
    const res = await runWorkflow(
      "t",
      [servicesStep],
      { graph: graph as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(res.ok).toBe(false)
    expect(engine.ensureImage).toHaveBeenCalledTimes(1)
    expect(String(res.error)).toContain("Image locale")
  })
})