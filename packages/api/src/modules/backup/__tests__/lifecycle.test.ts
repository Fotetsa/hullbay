import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BackupManifest, BackupRunPhase } from "@hullbay/shared"
import { LocalStorageProvider } from "../storage/local-provider"
import type { StorageProvider } from "../storage/types"
import type { ResolvedDestination } from "../storage/registry"
import { postgresStrategy } from "../strategies/postgres"
import type { StrategyTarget } from "../strategies/types"
import {
  BackupLifecycle,
  type ArtifactProducer,
  type ProducedArtifact,
  type RunStore,
  type RunTrigger,
} from "../engine/lifecycle"

class MemoryRunStore implements RunStore {
  runs: {
    id: string
    policyId: string
    status: string
    phase: BackupRunPhase
    errorCode?: string
    sizeBytes?: number
    phases: BackupRunPhase[]
  }[] = []
  artifacts: { id: string; runId: string; storageKey: string; manifest: BackupManifest }[] = []
  failArtifact = false

  async createRun(policyId: string, _trigger: RunTrigger) {
    const run = {
      id: `run_${this.runs.length + 1}`,
      policyId,
      status: "RUNNING",
      phase: "resolving" as BackupRunPhase,
      phases: [] as BackupRunPhase[],
    }
    this.runs.push(run)
    return { id: run.id }
  }
  async setPhase(runId: string, phase: BackupRunPhase) {
    const run = this.runs.find((r) => r.id === runId)!
    run.phase = phase
    run.phases.push(phase)
  }
  async complete(runId: string, sizeBytes: number) {
    const run = this.runs.find((r) => r.id === runId)!
    run.status = "COMPLETED"
    run.sizeBytes = sizeBytes
  }
  async fail(runId: string, errorCode: string) {
    const run = this.runs.find((r) => r.id === runId)!
    run.status = "FAILED"
    run.errorCode = errorCode
  }
  async createArtifact(input: {
    runId: string
    storageKey: string
    manifestJson: BackupManifest
  }) {
    if (this.failArtifact) throw new Error("base indisponible")
    const artifact = {
      id: `art_${this.artifacts.length + 1}`,
      runId: input.runId,
      storageKey: input.storageKey,
      manifest: input.manifestJson,
    }
    this.artifacts.push(artifact)
    return { id: artifact.id }
  }
}

const target: StrategyTarget = {
  nodeId: "node_1",
  name: "orders-db",
  kind: "postgres",
  engine: "postgres",
  engineVersion: "16",
  host: "boz_shop_db",
  port: 5432,
  database: "orders",
  username: "app",
  passwordSecretRef: "orders_db_password",
}

const destination: ResolvedDestination = {
  protocol: "s3",
  basePath: "hullbay",
  config: {
    protocol: "s3",
    bucket: "backups",
    accessKeyId: "k",
    secretAccessKey: "s",
    useTls: true,
    pathStyle: false,
  },
}

function makeProducer(
  provider: LocalStorageProvider,
  payload: Buffer,
  options: { corruptChecksum?: boolean; failAfterWrite?: boolean } = {},
): ArtifactProducer {
  return {
    async produce({ stagingPrefix, onPhase }) {
      const payloadFileName = "payload.sql.gz"
      const payloadKey = `${stagingPrefix}/${payloadFileName}`
      await onPhase("transferring")
      await provider.put(payloadKey, payload)
      if (options.failAfterWrite) throw new Error("connexion perdue")

      const checksum = options.corruptChecksum
        ? createHash("sha256").update("autre chose").digest("hex")
        : createHash("sha256").update(payload).digest("hex")

      return {
        payloadKey,
        payloadFileName,
        checksumSha256: checksum,
        sizeBytes: payload.length,
      } satisfies ProducedArtifact
    },
  }
}

describe("BackupLifecycle", () => {
  let root: string
  let provider: LocalStorageProvider
  let store: MemoryRunStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hullbay-lifecycle-"))
    provider = new LocalStorageProvider(root)
    store = new MemoryRunStore()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function lifecycle() {
    return new BackupLifecycle(store)
  }

  function input(producer: ArtifactProducer, overrides: Record<string, unknown> = {}) {
    return {
      policyId: "pol_1",
      targetId: "tgt_1",
      destinationId: "dst_1",
      projectSlug: "shop",
      trigger: "manual" as const,
      strategy: postgresStrategy,
      target,
      destination,
      provider,
      producer,
      verification: "checksum" as const,
      ...overrides,
    }
  }

  it("commite un artifact complet et suit toutes les phases", async () => {
    const payload = Buffer.from("dump-content")
    const result = await lifecycle().execute(input(makeProducer(provider, payload)))

    expect(result.ok).toBe(true)
    expect(store.artifacts).toHaveLength(1)
    expect(store.runs[0]!.status).toBe("COMPLETED")
    expect(store.runs[0]!.phases).toEqual([
      "resolving",
      "extracting",
      "transferring",
      "verifying",
      "committing",
      "done",
    ])

    const artifact = store.artifacts[0]!
    expect(artifact.storageKey).toBe(`hullbay/shop/orders-db/${artifact.manifest.artifactId}`)
    expect(await provider.stat(`${artifact.storageKey}/manifest.json`)).not.toBeNull()
    expect(await provider.stat(`${artifact.storageKey}/payload.sql.gz`)).not.toBeNull()
    expect(await provider.stat(`${artifact.storageKey}/payload.sha256`)).not.toBeNull()
    // Staging nettoyé.
    expect(await provider.list(".staging")).toEqual([])
  })

  it("ne crée aucun artifact si le transfert échoue", async () => {
    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("x"), { failAfterWrite: true })),
    )

    expect(result.ok).toBe(false)
    expect(store.artifacts).toHaveLength(0)
    expect(store.runs[0]!.status).toBe("FAILED")
    expect(await provider.list(".staging")).toEqual([])
  })

  it("refuse le commit quand le checksum distant diffère", async () => {
    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload"), { corruptChecksum: true })),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe("checksum_mismatch")
    expect(store.artifacts).toHaveLength(0)
    expect(store.runs[0]!.status).toBe("FAILED")
  })

  it("refuse le commit quand la taille distante diffère", async () => {
    const producer: ArtifactProducer = {
      async produce(ctx) {
        const produced = await makeProducer(provider, Buffer.from("12345")).produce(ctx)
        return { ...produced, sizeBytes: 999 }
      },
    }
    const result = await lifecycle().execute(input(producer))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe("verify_failed")
    expect(store.artifacts).toHaveLength(0)
  })

  it("dégrade le commit quand le backend ne supporte pas le rename", async () => {
    const noMove: StorageProvider = {
      id: "no-move",
      capabilities: () => provider.capabilities(),
      put: (key, data, opts) => provider.put(key, data, opts),
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: (prefix) => provider.list(prefix),
      delete: (key) => provider.delete(key),
      move: async () => false,
      hash: (key, algorithm) => provider.hash(key, algorithm),
      commitPayload: (input) => provider.commitPayload(input),
    }

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload")), { provider: noMove }),
    )
    expect(result.ok).toBe(true)
    expect(store.artifacts).toHaveLength(1)
    expect(await provider.list(".staging")).toEqual([])
  })

  it("ne crée aucun artifact si le manifest ne peut pas être écrit (commit incomplet)", async () => {
    const failingManifest: StorageProvider = {
      id: "manifest-fail",
      capabilities: () => provider.capabilities(),
      put: async (key, data, opts) => {
        if (key.endsWith("manifest.json")) throw new Error("quota dépassé")
        return provider.put(key, data, opts)
      },
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: (prefix) => provider.list(prefix),
      delete: (key) => provider.delete(key),
      move: (from, to) => provider.move(from, to),
      hash: (key, algorithm) => provider.hash(key, algorithm),
      commitPayload: (input) => provider.commitPayload(input),
    }

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload")), { provider: failingManifest }),
    )
    expect(result.ok).toBe(false)
    expect(store.artifacts).toHaveLength(0)
    expect(store.runs[0]!.status).toBe("FAILED")
    // Rollback post-commit : le payload promu et le checksum déjà écrits sont
    // supprimés, aucun objet durable ne survit sans manifest.
    expect(await provider.list("hullbay/shop/orders-db")).toEqual([])
  })

  it("annule le préfixe final si l'artifact ne peut pas être persisté en base", async () => {
    store.failArtifact = true
    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload"))),
    )

    expect(result.ok).toBe(false)
    expect(store.artifacts).toHaveLength(0)
    expect(store.runs[0]!.status).toBe("FAILED")
    // Le manifest avait été écrit ; le rollback le supprime en premier, puis
    // le payload et le checksum.
    expect(await provider.list("hullbay/shop/orders-db")).toEqual([])
    expect(await provider.list(".staging")).toEqual([])
  })

  it("annule une promotion partielle quand commitPayload échoue", async () => {
    const partial: StorageProvider = {
      id: "partial",
      capabilities: () => provider.capabilities(),
      put: (key, data, opts) => provider.put(key, data, opts),
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: (prefix) => provider.list(prefix),
      delete: (key) => provider.delete(key),
      move: (from, to) => provider.move(from, to),
      hash: (key, algorithm) => provider.hash(key, algorithm),
      commitPayload: async (commit) => {
        // Le provider a déjà copié le payload final avant d'échouer.
        await provider.put(commit.finalKey, Buffer.from("partiel"))
        throw new Error("copie interrompue")
      },
    }

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload")), { provider: partial }),
    )

    expect(result.ok).toBe(false)
    expect(store.artifacts).toHaveLength(0)
    expect(await provider.list("hullbay/shop/orders-db")).toEqual([])
  })

  it("supprime le manifest même si list() échoue pendant le rollback", async () => {
    const listFails: StorageProvider = {
      id: "list-fails",
      capabilities: () => provider.capabilities(),
      put: (key, data, opts) => provider.put(key, data, opts),
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: async (prefix) => {
        if (prefix.startsWith("hullbay/")) throw new Error("list indisponible")
        return provider.list(prefix)
      },
      delete: (key) => provider.delete(key),
      move: (from, to) => provider.move(from, to),
      hash: (key, algorithm) => provider.hash(key, algorithm),
      commitPayload: (commit) => provider.commitPayload(commit),
    }
    store.failArtifact = true

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload")), { provider: listFails }),
    )

    expect(result.ok).toBe(false)
    // list() a échoué : le payload peut rester, mais le manifest a été
    // supprimé explicitement, donc rien ne peut passer pour un artifact valide.
    const remaining = await provider.list("hullbay/shop/orders-db")
    expect(remaining.some((object) => object.key.endsWith("manifest.json"))).toBe(false)
  })

  it("consigne copy-verify-delete quand le backend ne supporte pas le rename (#4)", async () => {
    const noMove: StorageProvider = {
      id: "no-move",
      capabilities: () => provider.capabilities(),
      put: (key, data, opts) => provider.put(key, data, opts),
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: (prefix) => provider.list(prefix),
      delete: (key) => provider.delete(key),
      move: async () => false,
      hash: (key, algorithm) => provider.hash(key, algorithm),
      commitPayload: async () => "copy-verify-delete" as const,
    }

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload")), { provider: noMove }),
    )
    expect(result.ok).toBe(true)
    // Le mode réellement exécuté (copy-verify-delete) est enregistré, pas deviné.
    expect(store.artifacts[0]!.manifest.commit.mode).toBe("copy-verify-delete")
    expect(store.artifacts[0]!.manifest.verification.downgraded).toBe(false)
  })

  it("consigne le downgrade de vérif quand le backend n'a pas de hash natif (#3)", async () => {
    const noHash: StorageProvider = {
      id: "no-hash",
      capabilities: () => provider.capabilities(),
      put: (key, data, opts) => provider.put(key, data, opts),
      get: (key) => provider.get(key),
      stat: (key) => provider.stat(key),
      list: (prefix) => provider.list(prefix),
      delete: (key) => provider.delete(key),
      move: (from, to) => provider.move(from, to),
      hash: async () => null,
      commitPayload: async () => "atomic-rename" as const,
    }

    const result = await lifecycle().execute(
      input(makeProducer(provider, Buffer.from("payload"), ), { provider: noHash }),
    )
    expect(result.ok).toBe(true)
    // Vérification rétrogradée en taille, explicitement consignée.
    expect(store.artifacts[0]!.manifest.verification.mode).toBe("size")
    expect(store.artifacts[0]!.manifest.verification.downgraded).toBe(true)
  })

  it("refuse avant transfert si les prérequis échouent", async () => {
    const badVersion = { ...target, engineVersion: "pas-une-version" }
    const result = await lifecycle().execute(input(makeProducer(provider, Buffer.from("x")), { target: badVersion }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe("prereq_failed")
    expect(store.artifacts).toHaveLength(0)
  })
})
