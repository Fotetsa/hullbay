import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { EventEmitter } from "node:events"

const { mockPrisma, mockEventBus, mockDocker, mockGithub, mockSpawn } =
  vi.hoisted(() => ({
    mockPrisma: {
      systemInfo: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      systemUpdate: {
        findFirst: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
    },
    mockEventBus: { emit: vi.fn() },
    mockDocker: {
      ensureImage: vi.fn(),
      updateSystemServiceImage: vi.fn(),
      currentSystemTag: vi.fn(),
      findHullbayServices: vi.fn(),
    },
    mockGithub: {
      listReleases: vi.fn(),
      latest: vi.fn(),
      isUpdateAvailable: vi.fn(),
    },
    mockSpawn: vi.fn(),
  }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }))
vi.mock("../../../lib/prisma", () => ({ prisma: mockPrisma }))
vi.mock("../../../lib/event-bus", () => ({ eventBus: mockEventBus }))
vi.mock("../../docker-engine/service", () => ({
  DockerEngineService: {
    forCluster: vi.fn(async () => ({
      ensureImage: mockDocker.ensureImage,
      updateSystemServiceImage: mockDocker.updateSystemServiceImage,
      currentSystemTag: mockDocker.currentSystemTag,
      findHullbayServices: mockDocker.findHullbayServices,
    })),
  },
}));

vi.mock("../../docker-engine/client", () => ({
  getDefaultCluster: vi.fn(async () => ({
    id: "default-cluster-id",
    name: "Default",
    dockerHost: "tcp://socket-proxy:2375",
    caddyAdminUrl: "http://caddy:2019",
    isDefault: true,
  })),
}));
vi.mock("../github", () => ({
  githubReleasesService: mockGithub,
}))

import { updaterService } from "../updater"

const now = new Date("2026-08-08T00:00:00Z")

  const release = (version: string) => ({
    version,
    tag: `v${version}`,
    prerelease: false,
    draft: false,
    publishedAt: "2026-08-01T00:00:00Z",
    url: "",
    notes: `notes ${version}`,
  })

function mockSpawnSuccess() {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => child.emit("close", 0))
    return child
  })
}

describe("UpdaterService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.systemInfo.findUnique.mockResolvedValue({
      id: "singleton",
      currentVersion: "1.2.2",
      updateChannel: "stable",
      lastCheckAt: null,
      lastCheckResult: null,
      updatedAt: now,
    })
    mockPrisma.systemInfo.upsert.mockResolvedValue({
      id: "singleton",
      currentVersion: "1.2.2",
      updateChannel: "stable",
      lastCheckAt: null,
      lastCheckResult: null,
      updatedAt: now,
    })
    mockPrisma.systemUpdate.findFirst.mockResolvedValue(null)
    mockDocker.currentSystemTag.mockResolvedValue("1.2.2") // Mock par défaut pour current()
    mockPrisma.systemUpdate.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: "update-1",
      status: "running",
      fromVersion: "1.2.2",
      toVersion: "?",
      channel: "stable",
      steps: [],
      logs: [],
      startedAt: new Date(),
      createdAt: now,
      ...args.data,
    }))
    mockPrisma.systemUpdate.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: "update-1",
      status: "success",
      fromVersion: "1.2.2",
      toVersion: "1.2.3",
      channel: "stable",
      steps: [],
      logs: [],
      startedAt: now,
      createdAt: now,
      ...args.data,
    }))
    mockSpawnSuccess()
    process.env.DATABASE_URL = "postgresql://ops:pw@localhost:5432/hullbay"
    process.env.BACKUP_DIR = "/tmp/opencode/hullbay-backups"
    // Pas de service web Swarm dans les tests → waitForWebHealthy est un no-op.
    mockDocker.findHullbayServices.mockResolvedValue({})
    // Par défaut : aucune release (chaque test la branche au besoin).
    mockGithub.listReleases.mockResolvedValue([])
  })

  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.IMAGE_TAG
    delete process.env.GHCR_OWNER
  })

  describe("apply", () => {
    it("crée une update running et verrouille (refus si déjà en cours)", async () => {
      mockGithub.latest.mockResolvedValue({ version: "1.2.3", tag: "v1.2.3", prerelease: false, draft: false, publishedAt: null, url: "", notes: "" })
      mockGithub.isUpdateAvailable.mockReturnValue(true)
      mockDocker.ensureImage.mockResolvedValue({ pulled: true })
      mockDocker.updateSystemServiceImage.mockResolvedValue(undefined)

      const id = await updaterService.apply({ channel: "stable" }, "user-1")

      expect(id).toBe("update-1")
      expect(mockPrisma.systemUpdate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "running",
          fromVersion: "1.2.2",
          channel: "stable",
          triggeredById: "user-1",
        }),
      })

      // Concurrence : une update running existe déjà → erreur.
      mockPrisma.systemUpdate.findFirst.mockResolvedValue({ id: "other" })
      await expect(updaterService.apply({}, null)).rejects.toThrow("déjà en cours")
    })

    it("résout la version cible via le canal stable si non précisée", async () => {
      // Mock pour que current() retourne une version stable (sans suffix beta/alpha)
      mockDocker.currentSystemTag.mockResolvedValue("1.2.2")
      
      mockGithub.latest.mockResolvedValue({ version: "1.2.3", tag: "v1.2.3", prerelease: false, draft: false, publishedAt: null, url: "", notes: "" })
      mockGithub.isUpdateAvailable.mockReturnValue(true)
      mockDocker.ensureImage.mockResolvedValue({ pulled: true })
      mockDocker.updateSystemServiceImage.mockResolvedValue(undefined)

      await updaterService.apply({}, null)
      await updaterService.waitForPending()

      expect(mockGithub.latest).toHaveBeenCalledWith("stable")
      expect(mockDocker.ensureImage).toHaveBeenCalledWith(
        "ghcr.io/fotetsa/hullbay/api:1.2.3",
        "Always",
      )
      expect(mockDocker.updateSystemServiceImage).toHaveBeenCalledWith(
        "api",
        "ghcr.io/fotetsa/hullbay/api:1.2.3",
      )
    })

    it("refuse une cible non plus récente (anti-downgrade)", async () => {
      // Mock pour que current() retourne une version stable
      mockDocker.currentSystemTag.mockResolvedValue("1.2.2")
      
      // Canal beta : latest retourne une pre-release plus ancienne que l'installée.
      mockGithub.latest.mockResolvedValue({ version: "1.2.2", tag: "v1.2.2", prerelease: false, draft: false, publishedAt: null, url: "", notes: "" })
      mockGithub.isUpdateAvailable.mockReturnValue(false)
      mockDocker.ensureImage.mockResolvedValue({ pulled: true })

      await updaterService.apply({ channel: "beta" }, "user-1")
      await updaterService.waitForPending()

      expect(mockDocker.ensureImage).not.toHaveBeenCalled()
      const failedUpdate = mockPrisma.systemUpdate.update.mock.calls.find(
        (call) => call[0]?.data?.status === "failed",
      )
      expect(failedUpdate).toBeTruthy()
      expect(failedUpdate![0].data.error).toContain("anti-downgrade")
    })
  })

  describe("check", () => {
    it("détecte une mise à jour disponible et persiste le dernier check", async () => {
      mockGithub.listReleases.mockResolvedValue([release("1.2.3"), release("1.2.2")])
      mockGithub.isUpdateAvailable.mockReturnValue(true)

      const result = await updaterService.check("stable")

      expect(result.updateAvailable).toBe(true)
      expect(result.currentVersion).toBe("1.2.2")
      expect(result.latestVersion).toBe("1.2.3")
      expect(result.releases).toHaveLength(2)
      expect(result.releases[0]).toMatchObject({ version: "1.2.3", notes: "notes 1.2.3" })
      expect(mockPrisma.systemInfo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "singleton" },
          update: expect.objectContaining({
            lastCheckAt: expect.any(Date),
            lastCheckResult: { channel: "stable", latestVersion: "1.2.3", updateAvailable: true },
          }),
        }),
      )
    })

    it("signale pas de mise à jour quand la version courante est la dernière", async () => {
      mockGithub.listReleases.mockResolvedValue([release("1.2.2")])
      mockGithub.isUpdateAvailable.mockReturnValue(false)

      const result = await updaterService.check("stable")

      expect(result.updateAvailable).toBe(false)
      expect(result.latestVersion).toBe("1.2.2")
    })

    it("réagit en mode dégradé si GitHub est rate-limité (403) : pas de throw, resert l'état connu", async () => {
      // Dernière vérification réussie persistée (avant le 403).
      mockPrisma.systemInfo.findUnique.mockResolvedValue({
        id: "singleton",
        currentVersion: "1.2.2",
        updateChannel: "stable",
        lastCheckAt: now,
        lastCheckResult: { channel: "stable", latestVersion: "1.2.3", updateAvailable: true },
        updatedAt: now,
      })
      mockGithub.listReleases.mockRejectedValue(
        new Error("GitHub releases 403 : Forbidden — rate-limit, configure GITHUB_TOKEN"),
      )
      mockGithub.isUpdateAvailable.mockReturnValue(true)

      const result = await updaterService.check("stable")

      expect(result.degraded).toContain("403")
      // État connu reserté au lieu d'un throw.
      expect(result.updateAvailable).toBe(true)
      expect(result.latestVersion).toBe("1.2.3")
      expect(result.latest).toBeNull()
      expect(result.releases).toEqual([])
      expect(result.lastCheckAt).toBe(now)
      // On ne réécrit PAS le dernier check (il est déjà le bon).
      expect(mockPrisma.systemInfo.upsert).not.toHaveBeenCalled()
    })

    it("résout le placeholder 'latest' (install.sh) vers le tag réellement déployé", async () => {
      // DB seedée avec "latest" (défaut install.sh) → comparaison semver cassée.
      mockPrisma.systemInfo.findUnique.mockResolvedValue({
        id: "singleton",
        currentVersion: "latest",
        updateChannel: "stable",
        lastCheckAt: null,
        lastCheckResult: null,
        updatedAt: now,
      })
      // Le service api tourne réellement sur 1.2.2 (source de vérité).
      mockDocker.currentSystemTag.mockResolvedValue("1.2.2")
      mockPrisma.systemInfo.update.mockResolvedValue({
        id: "singleton",
        currentVersion: "1.2.2",
        updateChannel: "stable",
        lastCheckAt: null,
        lastCheckResult: null,
        updatedAt: now,
      })
      mockGithub.listReleases.mockResolvedValue([release("1.2.3")])
      mockGithub.isUpdateAvailable.mockReturnValue(true)

      const result = await updaterService.check("stable")

      expect(result.currentVersion).toBe("1.2.2")
      expect(result.updateAvailable).toBe(true)
      // Le placeholder est persisté corrigé (auto-réparation).
      expect(mockPrisma.systemInfo.update).toHaveBeenCalledWith({
        where: { id: "singleton" },
        data: { 
          currentVersion: "1.2.2",
          updateChannel: "stable"
        },
      })
    })
  })

  describe("setChannel", () => {
    it("persiste le canal sur le singleton et audite le changement", async () => {
      await updaterService.setChannel("beta")
      // findUnique (défaut beforeEach : "stable") → upsert avec history complète.
      const updatedArgs = mockPrisma.systemInfo.upsert.mock.calls[0]![0]
      expect(mockPrisma.systemInfo.upsert).toHaveBeenCalledWith({
        where: { id: "singleton" },
        create: { id: "singleton", updateChannel: "beta", channelHistory: expect.any(Array) },
        update: { updateChannel: "beta", channelHistory: expect.any(Array) },
      })
      const entry = updatedArgs.update.channelHistory[0] as { at: Date; from: string; to: string }
      expect(entry.from).toBe("stable")
      expect(entry.to).toBe("beta")
      expect(entry.at).toBeInstanceOf(Date)
    })

    it("no-op si le canal est déjà en vigueur (pas d'entrée d'audit doublon)", async () => {
      await updaterService.setChannel("stable")
      expect(mockPrisma.systemInfo.upsert).not.toHaveBeenCalled()
    })

    it("appende à l'historique existant (max 10)", async () => {
      mockPrisma.systemInfo.findUnique.mockResolvedValue({
        id: "singleton",
        currentVersion: "1.2.2",
        updateChannel: "stable",
        lastCheckAt: null,
        lastCheckResult: null,
        // 10 entrées existantes → la nouvelle doit pousser la plus vieille dehors.
        channelHistory: Array.from({ length: 10 }, (_, i) => ({ at: now, from: "stable", to: "beta", i })),
        updatedAt: now,
      })
      await updaterService.setChannel("beta")

      const { update } = mockPrisma.systemInfo.upsert.mock.calls[0]![0]
      expect(update.channelHistory).toHaveLength(10)
      expect(update.channelHistory[0].to).toBe("beta")
    })
  })

  describe("history", () => {
    it("pagine (limit/offset) avec total et hasMore", async () => {
      mockPrisma.systemUpdate.findMany.mockResolvedValue([{ id: "u1", status: "success" }])
      mockPrisma.systemUpdate.count.mockResolvedValue(21)

      const result = await updaterService.history({ limit: 20, offset: 0 })

      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(21)
      expect(result.hasMore).toBe(true)
      expect(mockPrisma.systemUpdate.findMany).toHaveBeenCalledWith({
        where: undefined,
        orderBy: { createdAt: "desc" },
        take: 20,
        skip: 0,
      })
    })

    it("filtre par statut et calcule hasMore=false en fin de liste", async () => {
      mockPrisma.systemUpdate.findMany.mockResolvedValue([{ id: "u2", status: "failed" }])
      mockPrisma.systemUpdate.count.mockResolvedValue(1)

      const result = await updaterService.history({ limit: 20, offset: 20, status: "failed" })

      expect(result.hasMore).toBe(false)
      expect(mockPrisma.systemUpdate.count).toHaveBeenCalledWith({ where: { status: "failed" } })
      expect(mockPrisma.systemUpdate.findMany).toHaveBeenCalledWith({
        where: { status: "failed" },
        orderBy: { createdAt: "desc" },
        take: 20,
        skip: 20,
      })
    })
  })

  describe("dumpDatabase", () => {
    it("exclut les tables de métadonnée (SystemUpdate/SystemInfo/_prisma_migrations)", async () => {
      await updaterService.dumpDatabase("/tmp/opencode/x.sql")

      const dump = mockSpawn.mock.calls.find(([cmd]) => cmd === "pg_dump")
      expect(dump).toBeTruthy()
      const args = dump![1] as string[]
      expect(args[0]).toBe("-Fc")
      expect(args).toContain("-T")
      expect(args).toContain('public."SystemUpdate"')
      expect(args).toContain('public."SystemInfo"')
      expect(args).toContain('public."_prisma_migrations"')
    })
  })

  describe("rollback", () => {
    /** Success update classique + garde latest satisfaite (tag api = toVersion). */
    const successUpdate = () => ({
      id: "update-1",
      status: "success",
      rolledBack: false,
      rollbackOfId: null,
      fromVersion: "1.2.2",
      toVersion: "1.2.3",
      channel: "stable",
      steps: [],
      logs: [],
      error: null,
      startedAt: now,
      createdAt: now,
    })

    beforeEach(() => {
      mockDocker.currentSystemTag.mockResolvedValue("1.2.3")
    })

    it("crée un enregistrement dédié (rollbackOfId) puis restore + redeploie l'ancien tag", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())

      const rbId = await updaterService.rollback("update-1", "user-1")

      expect(rbId).toBe("update-1")
      // Nouvel enregistrement : versants inversés + lien vers l'update source.
      expect(mockPrisma.systemUpdate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "running",
          fromVersion: "1.2.3",
          toVersion: "1.2.2",
          rollbackOfId: "update-1",
          triggeredById: "user-1",
        }),
      })
      expect(mockDocker.updateSystemServiceImage).toHaveBeenCalledWith(
        "web",
        "ghcr.io/fotetsa/hullbay/web:1.2.2",
      )
      expect(mockDocker.updateSystemServiceImage).toHaveBeenCalledWith(
        "api",
        "ghcr.io/fotetsa/hullbay/api:1.2.2",
      )
      const restoreCall = mockSpawn.mock.calls.find(
        ([cmd, args]) => cmd === "pg_restore" && args.includes("-d"),
      )
      expect(restoreCall).toBeTruthy()
      // SÉCURITÉ : DATABASE_URL (password) ne doit JAMAIS transiter en argv
      // (visible via `ps` sur le nœud Swarm) — uniquement via env PG*.
      const allArgs = JSON.stringify(mockSpawn.mock.calls.map((call) => call[1]))
      expect(allArgs).not.toContain("postgresql://")
      const pgEnvCall = mockSpawn.mock.calls.find(
        ([cmd, args]) => cmd === "pg_restore" && args.includes("-d"),
      )
      expect(pgEnvCall?.[2]?.env).toMatchObject({
        PGDATABASE: "hullbay",
        PGHOST: "localhost",
        PGPASSWORD: "pw",
      })
      // -d explicite : pg_restore ignore PGDATABASE (fix commande).
      expect(pgEnvCall?.[1]).toContain("-d")
      // ORDRE CRITIQUE : le restore DB précède TOUT redeploy — le redeploy API
      // tue le process (self-terminating), le dump doit être déjà restauré.
      const restoreIdx = mockSpawn.mock.calls.findIndex(
        ([cmd, args]) => cmd === "pg_restore" && args.includes("-d"),
      )
      const restoreOrder = mockSpawn.mock.invocationCallOrder[restoreIdx]!
      const webOrder = mockDocker.updateSystemServiceImage.mock.invocationCallOrder[0]!
      expect(restoreOrder).toBeLessThan(webOrder)
      // L'enregistrement rollback passe rolled_back AVANT le redeploy API.
      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "rolled_back" }) }),
      )
      // L'update source est marquée annulée (bouton rollback disparaît).
      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith({
        where: { id: "update-1" },
        data: { rolledBack: true },
      })
      expect(mockPrisma.systemInfo.update).toHaveBeenCalledWith({
        where: { id: "singleton" },
        data: { currentVersion: "1.2.2" },
      })
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        "update.done",
        expect.objectContaining({ updateId: "update-1", status: "rolled_back" }),
      )
    })

    it("refuse le rollback d'une update introuvable", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(null)

      await expect(updaterService.rollback("nope", null)).rejects.toThrow("introuvable")
    })

    it("refuse le rollback d'une update non réussie (apply échouée = rien à annuler)", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue({
        ...successUpdate(),
        status: "failed",
        error: "boom",
      })

      await expect(updaterService.rollback("update-1", null)).rejects.toThrow(
        "seule une mise à jour réussie est annulable",
      )
      expect(mockPrisma.systemUpdate.create).not.toHaveBeenCalled()
    })

    it("refuse un double rollback (déjà annulée)", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue({
        ...successUpdate(),
        rolledBack: true,
      })

      await expect(updaterService.rollback("update-1", null)).rejects.toThrow("déjà rollbacké")
    })

    it("refuse le rollback d'une update dépassée (version plus récente déployée)", async () => {
      // Le tag api tourne sur 1.2.4 → rollbacker 1.2.3 restaurerait un dump
      // obsolète sur des données plus récentes (perte de données).
      mockDocker.currentSystemTag.mockResolvedValue("1.2.4")
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())

      await expect(updaterService.rollback("update-1", null)).rejects.toThrow(
        "update dépassée — rollback impossible",
      )
      expect(mockPrisma.systemUpdate.create).not.toHaveBeenCalled()
    })

    it("refuse le rollback d'une update sans fromVersion (pas de cible de restore)", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue({ ...successUpdate(), fromVersion: "" })

      await expect(updaterService.rollback("update-1", null)).rejects.toThrow(
        "version source inconnue — rollback impossible",
      )
      expect(mockPrisma.systemUpdate.create).not.toHaveBeenCalled()
    })

    it("persiste failed + émet update.error si le restore échoue, et NE marque PAS l'update source", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())
      // pg_restore échoue (close != 0).
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        setImmediate(() => child.emit("close", 1))
        return child
      })

      await expect(updaterService.rollback("update-1", null)).rejects.toThrow()
      // L'enregistrement rollback est failed (pas rolled_back).
      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
      )
      // L'update source reste rollbackable (bouton persiste) → retry possible.
      expect(mockPrisma.systemUpdate.update).not.toHaveBeenCalledWith({
        where: { id: "update-1" },
        data: { rolledBack: true },
      })
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        "update.error",
        expect.objectContaining({ updateId: "update-1" }),
      )
    })

    it("régénère le dump (exclusions) si l'archive pré-fix contient SystemUpdate", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())
      // `pg_restore --list` révèle SystemUpdate (dump produit par un code pré-fix).
      mockSpawn.mockImplementation((cmd: string) => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        if (cmd === "pg_restore") {
          setImmediate(() =>
            child.stdout.emit("data", Buffer.from('\tTABLE public "SystemUpdate"\n')),
          )
        }
        setImmediate(() => child.emit("close", 0))
        return child
      })

      await updaterService.rollback("update-1", null)

      // Le restore cible le dump régénéré, jamais l'archive pré-fix obsolète.
      const restoreArgs = mockSpawn.mock.calls.find(
        ([c, a]) => c === "pg_restore" && a.includes("-d"),
      )?.[1] as string[]
      expect(restoreArgs.join(" ")).toContain(".regen")
    })

    it("restore directement l'archive si elle est déjà propre (exclusions)", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())

      await updaterService.rollback("update-1", null)

      // `--list` ne révèle pas SystemUpdate → restore sur l'archive d'origine.
      const restoreArgs = mockSpawn.mock.calls.find(
        ([c, a]) => c === "pg_restore" && a.includes("-d"),
      )?.[1] as string[]
      expect(restoreArgs.join(" ")).not.toContain(".regen")
      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith({
        where: { id: "update-1" },
        data: { rolledBack: true },
      })
    })

    it("régénère le dump si l'archive est illisible (pg_dump plus récent que le client)", async () => {
      mockPrisma.systemUpdate.findUnique.mockResolvedValue(successUpdate())
      // `pg_restore --list` échoue : archive d'un pg_dump 18 lue par un client 16
      // (« unsupported version (1.16) »). On ne peut pas l'inspecter → regen.
      mockSpawn.mockImplementation((cmd: string, args: string[]) => {
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        if (cmd === "pg_restore" && args[0] === "--list") {
          setImmediate(() =>
            child.stderr.emit("data", Buffer.from("unsupported version (1.16) in file header\n")),
          )
          setImmediate(() => child.emit("close", 1))
        } else {
          setImmediate(() => child.emit("close", 0))
        }
        return child
      })

      await updaterService.rollback("update-1", null)

      const restoreArgs = mockSpawn.mock.calls.find(
        ([c, a]) => c === "pg_restore" && a.includes("-d"),
      )?.[1] as string[]
      expect(restoreArgs.join(" ")).toContain(".regen")
    })
  })

  describe("finalizeOrphanUpdates", () => {
    it("marque success si le tag déployé du service api a atteint la version cible", async () => {
      mockDocker.currentSystemTag.mockResolvedValue("1.2.3")
      mockPrisma.systemUpdate.findMany.mockResolvedValue([
        {
          id: "orphan-1",
          status: "running",
          fromVersion: "1.2.2",
          toVersion: "1.2.3",
          channel: "stable",
          steps: [],
          logs: [],
          startedAt: now,
          createdAt: now,
        },
      ])

      await updaterService.finalizeOrphanUpdates()

      expect(mockDocker.currentSystemTag).toHaveBeenCalledWith("api")
      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith({
        where: { id: "orphan-1" },
        data: { status: "success", finishedAt: expect.any(Date), error: null },
      })
      expect(mockEventBus.emit).toHaveBeenCalledWith("update.done", expect.objectContaining({ updateId: "orphan-1", status: "success" }))
    })

    it("tolère le préfixe v sur le tag déployé", async () => {
      mockDocker.currentSystemTag.mockResolvedValue("v1.2.3")
      mockPrisma.systemUpdate.findMany.mockResolvedValue([
        {
          id: "orphan-1",
          status: "running",
          fromVersion: "1.2.2",
          toVersion: "1.2.3",
          channel: "stable",
          steps: [],
          logs: [],
          startedAt: now,
          createdAt: now,
        },
      ])

      await updaterService.finalizeOrphanUpdates()

      expect(mockPrisma.systemUpdate.update).toHaveBeenCalledWith({
        where: { id: "orphan-1" },
        data: { status: "success", finishedAt: expect.any(Date), error: null },
      })
    })

    it("déclenche le rollback si le tag déployé n'a pas atteint la cible", async () => {
      mockDocker.currentSystemTag.mockResolvedValue("1.2.2")
      mockPrisma.systemUpdate.findMany.mockResolvedValue([
        {
          id: "orphan-1",
          status: "running",
          fromVersion: "1.2.2",
          toVersion: "1.2.3",
          channel: "stable",
          steps: [],
          logs: [],
          startedAt: now,
          createdAt: now,
        },
      ])
      mockPrisma.systemUpdate.findUnique.mockResolvedValue({
        id: "orphan-1",
        status: "running",
        fromVersion: "1.2.2",
        toVersion: "1.2.3",
        channel: "stable",
        steps: [],
        logs: [],
        startedAt: now,
        createdAt: now,
      })
      process.env.DATABASE_URL = "postgresql://ops:pw@localhost:5432/hullbay"

      await updaterService.finalizeOrphanUpdates()

      // rollback → au moins un update status rolled_back (ou une tentative).
      const updateCalls = mockPrisma.systemUpdate.update.mock.calls
      const statuses = updateCalls
        .map((call) => (call[0] as { data?: { status?: string } })?.data?.status)
        .filter(Boolean)
      expect(statuses).toContain("rolled_back")
    })

    it("ne rollback JAMAIS si le tag déployé est illisible (docker down au boot)", async () => {
      mockDocker.currentSystemTag.mockResolvedValue(null)
      mockPrisma.systemUpdate.findMany.mockResolvedValue([
        {
          id: "orphan-1",
          status: "running",
          fromVersion: "1.2.2",
          toVersion: "1.2.3",
          channel: "stable",
          steps: [],
          logs: [],
          startedAt: now,
          createdAt: now,
        },
      ])

      await updaterService.finalizeOrphanUpdates()

      // pg_restore destructif : AUCUN appel spawn, statut laissé en running.
      expect(mockSpawn).not.toHaveBeenCalledWith("pg_restore", expect.anything())
      expect(mockPrisma.systemUpdate.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "rolled_back" }) }),
      )
      expect(mockPrisma.systemUpdate.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
      )
    })
  })
})
