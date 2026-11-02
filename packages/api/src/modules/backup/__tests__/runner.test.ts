import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerEngineService } from "../../docker-engine/service"
import { SwarmBackupRunner } from "../runner"
import { SwarmStorageProvider } from "../storage/swarm-provider"
import type { ResolvedDestination } from "../storage/registry"
import { UNPROBED_CAPABILITIES, type StorageCapabilities } from "../storage/types"
import { postgresStrategy } from "../strategies/postgres"

const checksum = "c".repeat(64)

const destination: ResolvedDestination = {
  protocol: "s3",
  basePath: "hullbay",
  config: {
    protocol: "s3",
    bucket: "backups",
    accessKeyId: "AKIA",
    secretAccessKey: "super-secret",
    useTls: true,
    pathStyle: false,
  },
}

const target = {
  nodeId: "n1",
  name: "orders-db",
  kind: "postgres" as const,
  engine: "postgres",
  engineVersion: "16",
  host: "boz_shop_db",
  port: 5432,
  database: "orders",
  username: "app",
  passwordSecretRef: "orders_db_password",
}

type FakeTask = {
  Status?: { State?: string }
  ContainerStatus?: { ExitCode?: number }
}

function fakeEngine(logs = `HULLBAY_BACKUP_RESULT 42 ${checksum}`) {
  return {
    upsertSecret: vi.fn(async () => "secret-id"),
    removeSecret: vi.fn(async () => undefined),
    createService: vi.fn(async () => ({ ID: "svc_1" })),
    listServiceTasks: vi.fn(async (): Promise<FakeTask[]> => [{ Status: { State: "complete" } }]),
    serviceLogs: vi.fn(async () => logs),
    removeService: vi.fn(async () => undefined),
  }
}

function makeRunner(engine: DockerEngineService) {
  return new SwarmBackupRunner({
    engine,
    storage: {
      stagingUploadScript: (key) => `rclone rcat "$REMOTE/${key}"`,
      remoteString: () => "s3,bucket=backups",
      transportSecret: () => null,
    },
    image: "ghcr.io/hullbay/backup-runner:latest",
    networkName: "boz_shop_orders-db-net",
    timeoutSec: 30,
    pollMs: 1,
  })
}

describe("SwarmBackupRunner.produce", () => {
  let engine: ReturnType<typeof fakeEngine>

  beforeEach(() => {
    engine = fakeEngine()
  })

  it("transfère en streaming et retourne la taille + le checksum", async () => {
    const produced = await makeRunner(engine as unknown as DockerEngineService).produce({
      runId: "run_1",
      artifactId: "bak_1",
      stagingPrefix: ".staging/run_1",
      destination,
      target,
      plan: postgresStrategy.backup(target),
      onPhase: async () => undefined,
    })

    expect(produced).toMatchObject({ sizeBytes: 42, checksumSha256: checksum })
    expect(produced.payloadKey).toBe(".staging/run_1/payload.sql.gz")
  })

  it("ne met aucun credential dans l'env ni la commande du service", async () => {
    await makeRunner(engine as unknown as DockerEngineService).produce({
      runId: "run_1",
      artifactId: "bak_1",
      stagingPrefix: ".staging/run_1",
      destination,
      target,
      plan: postgresStrategy.backup(target),
      onPhase: async () => undefined,
    })

    const [, config, , networks, mounts] = (engine.createService as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    expect(JSON.stringify(config.env)).not.toContain("super-secret")
    expect(JSON.stringify(config.cmd)).not.toContain("super-secret")
    expect(JSON.stringify(config.cmd)).toContain("rclone rcat")
    expect(config.cmd).toContain("/bin/bash")
    expect(config.restartPolicy).toBe("no")
    expect(networks).toEqual(["boz_shop_orders-db-net"])
    expect(mounts).toEqual([])
  })

  it("monte le secret DB par référence, sans le recopier", async () => {
    await makeRunner(engine as unknown as DockerEngineService).produce({
      runId: "run_1",
      artifactId: "bak_1",
      stagingPrefix: ".staging/run_1",
      destination,
      target,
      plan: postgresStrategy.backup(target),
      onPhase: async () => undefined,
    })
    const [, config] = (engine.createService as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(config.secrets).toContainEqual({
      secretName: "orders_db_password",
      target: "/run/secrets/db_password",
    })
    expect(config.env.DB_PASSWORD_FILE).toBe("/run/secrets/db_password")
  })

  it("nettoie toujours le service et les secrets", async () => {
    await makeRunner(engine as unknown as DockerEngineService).produce({
      runId: "run_1",
      artifactId: "bak_1",
      stagingPrefix: ".staging/run_1",
      destination,
      target,
      plan: postgresStrategy.backup(target),
      onPhase: async () => undefined,
    })
    expect(engine.removeService).toHaveBeenCalledWith("svc_1")
    expect(engine.removeSecret).toHaveBeenCalled()
  })

  it("échoue si le task ne rend pas de résultat exploitable", async () => {
    const broken = fakeEngine("bruit sans marqueur")
    await expect(
      makeRunner(broken as unknown as DockerEngineService).produce({
        runId: "run_1",
        artifactId: "bak_1",
        stagingPrefix: ".staging/run_1",
        destination,
        target,
        plan: postgresStrategy.backup(target),
        onPhase: async () => undefined,
      }),
    ).rejects.toThrow(/résultat exploitable/)
  })

  it("classe un exit 3 en prereq_failed", async () => {
    engine.listServiceTasks.mockResolvedValue([
      { Status: { State: "failed" }, ContainerStatus: { ExitCode: 3 } },
    ])
    engine.serviceLogs.mockResolvedValue("pg_dump 14 < serveur 16")
    await expect(
      makeRunner(engine as unknown as DockerEngineService).produce({
        runId: "run_1",
        artifactId: "bak_1",
        stagingPrefix: ".staging/run_1",
        destination,
        target,
        plan: postgresStrategy.backup(target),
        onPhase: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "prereq_failed" })
  })

  it("classe une erreur rclone en destination_unreachable et purge les secrets des logs", async () => {
    engine.listServiceTasks.mockResolvedValue([{ Status: { State: "failed" } }])
    engine.serviceLogs.mockResolvedValue(
      "rclone: Failed to create file: dial tcp 10.0.0.1:443: connect: connection refused ,secret_access_key=super-secret",
    )
    const error = await makeRunner(engine as unknown as DockerEngineService)
      .produce({
        runId: "run_1",
        artifactId: "bak_1",
        stagingPrefix: ".staging/run_1",
        destination,
        target,
        plan: postgresStrategy.backup(target),
        onPhase: async () => undefined,
      })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: "destination_unreachable" })
    expect((error as { logs?: string }).logs).not.toContain("super-secret")
  })
})

describe("SwarmStorageProvider", () => {
  function makeProvider(
    engine: DockerEngineService,
    capabilities?: StorageCapabilities | null,
  ) {
    return new SwarmStorageProvider(
      {
        engine,
        image: "ghcr.io/hullbay/backup-runner:latest",
        networkName: "boz_shop_orders-db-net",
        timeoutSec: 30,
        pollMs: 1,
        capabilities,
      },
      destination,
    )
  }

  it("déclare la matrice du probe, ou aucune capacité si non sondée", () => {
    const caps: StorageCapabilities = {
      read: true,
      write: true,
      delete: true,
      move: false,
      checksum: false,
      atomicCommit: false,
      serverSideEncryption: false,
    }
    expect(makeProvider(fakeEngine() as unknown as DockerEngineService, caps).capabilities()).toEqual(
      caps,
    )
    expect(
      makeProvider(fakeEngine() as unknown as DockerEngineService).capabilities(),
    ).toEqual(UNPROBED_CAPABILITIES)
  })

  it("list retourne des clés complètes, directement supprimables", async () => {
    const engine = fakeEngine('[{"Path":"payload.sql.gz","Size":5,"IsDir":false}]')
    const entries = await makeProvider(
      engine as unknown as DockerEngineService,
    ).list("hullbay/shop/orders-db/bak_1")
    expect(entries).toEqual([
      {
        key: "hullbay/shop/orders-db/bak_1/payload.sql.gz",
        size: 5,
        modifiedAt: undefined,
      },
    ])
  })

  it("put crée le secret blob avec le contenu puis le nettoie", async () => {
    const engine = fakeEngine()
    await makeProvider(engine as unknown as DockerEngineService).put(
      "hullbay/shop/orders-db/bak_1/manifest.json",
      Buffer.from('{"ok":true}'),
    )
    expect(engine.upsertSecret).toHaveBeenCalledWith(
      expect.stringMatching(/^sp_blob_/),
      '{"ok":true}',
      expect.anything(),
    )
    const [, config] = (engine.createService as ReturnType<typeof vi.fn>).mock.calls[0]!
    const script = (config.cmd as string[])[2]!
    expect(script).toContain("rclone rcat")
    expect(script).toContain("/run/secrets/blob")
    expect(engine.removeSecret).toHaveBeenCalledWith(expect.stringMatching(/^sp_blob_/))
  })

  it("vérifie taille et checksum distants puis promeut en atomic-rename", async () => {
    const engine = fakeEngine("HULLBAY_COMMIT_MODE atomic-rename")
    const mode = await makeProvider(engine as unknown as DockerEngineService).commitPayload({
      stagingKey: ".staging/run_1/payload.sql.gz",
      finalKey: "hullbay/shop/orders-db/bak_1/payload.sql.gz",
      expectedChecksum: checksum,
      expectedSizeBytes: 42,
    })
    expect(mode).toBe("atomic-rename")
    const [, config] = (engine.createService as ReturnType<typeof vi.fn>).mock.calls[0]!
    const script = (config.cmd as string[])[2]!
    expect(script).toContain("rclone moveto")
    expect(script).toContain("hashsum sha256")
    expect(script).toContain("rclone lsjson --stat")
    expect(script).toContain("EXPECTED_SIZE")
    expect(script).toContain("HULLBAY_COMMIT_MODE")
    const remoteSecret = (config.secrets as { secretName: string; target: string }[]).find(
      (s) => s.target === "/run/secrets/backup_remote",
    )
    expect(remoteSecret?.secretName).toMatch(/^sp_remote_/)
    expect(engine.removeService).toHaveBeenCalled()
  })

  it("classe une taille distante différente en verify_failed", async () => {
    const engine = fakeEngine()
    engine.listServiceTasks.mockResolvedValue([
      { Status: { State: "failed" }, ContainerStatus: { ExitCode: 8 } },
    ])
    engine.serviceLogs.mockResolvedValue("taille distante differente")
    await expect(
      makeProvider(engine as unknown as DockerEngineService).commitPayload({
        stagingKey: ".staging/run_1/payload.sql.gz",
        finalKey: "hullbay/shop/orders-db/bak_1/payload.sql.gz",
        expectedChecksum: checksum,
        expectedSizeBytes: 42,
      }),
    ).rejects.toMatchObject({ code: "verify_failed" })
  })

  it("classe un exit 4 (checksum distant) en checksum_mismatch", async () => {
    const engine = fakeEngine()
    engine.listServiceTasks.mockResolvedValue([
      { Status: { State: "failed" }, ContainerStatus: { ExitCode: 4 } },
    ])
    engine.serviceLogs.mockResolvedValue("checksum distant different")
    await expect(
      makeProvider(engine as unknown as DockerEngineService).commitPayload({
        stagingKey: ".staging/run_1/payload.sql.gz",
        finalKey: "hullbay/shop/orders-db/bak_1/payload.sql.gz",
        expectedChecksum: checksum,
        expectedSizeBytes: 42,
      }),
    ).rejects.toMatchObject({ code: "checksum_mismatch" })
  })

  it("classe un échec de commit non identifiable en commit_failed", async () => {
    const engine = fakeEngine()
    engine.listServiceTasks.mockResolvedValue([{ Status: { State: "failed" } }])
    engine.serviceLogs.mockResolvedValue("erreur inconnue")
    await expect(
      makeProvider(engine as unknown as DockerEngineService).commitPayload({
        stagingKey: ".staging/run_1/payload.sql.gz",
        finalKey: "hullbay/shop/orders-db/bak_1/payload.sql.gz",
        expectedChecksum: checksum,
        expectedSizeBytes: 42,
      }),
    ).rejects.toMatchObject({ code: "commit_failed" })
  })
})
