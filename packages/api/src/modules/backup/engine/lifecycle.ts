import { randomUUID } from "node:crypto"
import type { BackupManifest, BackupRunPhase } from "@hullbay/shared"
import { scrubSecrets } from "../storage/remote-string"
import { StorageProviderError, type StorageProvider } from "../storage/types"
import type { ResolvedDestination } from "../storage/registry"
import { artifactPrefix, buildManifest, CHECKSUM_FILE, MANIFEST_FILE } from "../manifest"
import type { BackupStrategy, StrategyPlan, StrategyTarget } from "../strategies/types"

/**
 * Cycle de vie d'un backup.
 *
 * Invariant central : un artifact n'existe qu'après vérification ET commit.
 * `partial backup ≠ valid backup` — toute erreur avant le commit laisse zéro
 * artifact et ne peut jamais déclencher de rétention.
 */

export type RunTrigger = "manual" | "scheduled"

export interface ProducedArtifact {
  /** Clé du payload encore en staging. */
  payloadKey: string
  payloadFileName: string
  checksumSha256: string
  sizeBytes: number
}

export interface ArtifactProducer {
  /**
   * Extraction + staging put (fusionnés par streaming dans un task Swarm).
   * La vérification distante et la promotion (commit) sont déléguées au
   * StorageProvider par le lifecycle — le producteur ne possède pas de
   * lifecycle de stockage (reviewer #2/#3/#4).
   */
  produce(ctx: {
    runId: string
    artifactId: string
    /** Préfixe de staging imposé par le moteur (nettoyé dans tous les cas). */
    stagingPrefix: string
    destination: ResolvedDestination
    target: StrategyTarget
    plan: StrategyPlan
    onPhase: (phase: BackupRunPhase) => Promise<void>
  }): Promise<ProducedArtifact>
  /** Nettoyage du staging après échec (délégué au StorageProvider sinon). */
  cleanup?(stagingPrefix: string): Promise<void>
}

export interface RunStore {
  createRun(policyId: string, trigger: RunTrigger): Promise<{ id: string }>
  setPhase(runId: string, phase: BackupRunPhase): Promise<void>
  complete(runId: string, sizeBytes: number): Promise<void>
  fail(runId: string, errorCode: string, errorMessage: string): Promise<void>
  createArtifact(input: {
    runId: string
    targetId: string
    destinationId: string
    storageKey: string
    manifestJson: BackupManifest
    payloadFormat: string
    checksumSha256: string
    sizeBytes: number
    engine: string
    engineVersion: string
    strategyId: string
    formatVersion: number
  }): Promise<{ id: string }>
}

export interface LifecycleInput {
  policyId: string
  targetId: string
  destinationId: string
  projectSlug: string
  trigger: RunTrigger
  strategy: BackupStrategy
  target: StrategyTarget
  destination: ResolvedDestination
  /** Absent pour un runner distant (le stockage n'est pas monté dans l'API). */
  provider?: StorageProvider
  producer: ArtifactProducer
  verification: "size" | "checksum"
}

export type LifecycleResult =
  | { ok: true; runId: string; artifactId: string; sizeBytes: number }
  | { ok: false; runId: string; errorCode: string }

export class BackupError extends Error {
  readonly logs?: string
  readonly exitCode?: number

  constructor(
    readonly code: string,
    message: string,
    details: { logs?: string; exitCode?: number } = {},
  ) {
    super(message)
    this.name = "BackupError"
    this.logs = details.logs
    this.exitCode = details.exitCode
  }
}

async function cleanupPrefix(
  provider: StorageProvider,
  prefix: string,
): Promise<void> {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "")
  // Garde destructive : un préfixe vide ferait porter le nettoyage sur la
  // racine du remote. Aucun appelant légitime ne doit arriver ici.
  if (cleanPrefix.length === 0) return
  const manifestKey = `${cleanPrefix}/${MANIFEST_FILE}`
  // Suppression explicite du manifest AVANT le listing : si `list()` échoue,
  // l'invariant « pas de manifest → pas d'artifact valide » tient quand même.
  await provider.delete(manifestKey).catch(() => undefined)
  try {
    for (const object of await provider.list(cleanPrefix)) {
      await provider.delete(object.key).catch(() => undefined)
    }
  } catch {
    // Best-effort : sans manifest, un résidu n'est jamais listé comme
    // artifact restaurable.
  }
}

export class BackupLifecycle {
  constructor(private readonly store: RunStore) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    const run = await this.store.createRun(input.policyId, input.trigger)
    const artifactId = `bak_${randomUUID()}`
    const stagingPrefix = `.staging/${run.id}`
    let produced: ProducedArtifact | undefined
    /** Préfixe final promu : à annuler si l'artifact n'est pas persisté. */
    let committedPrefix: string | null = null
    /** Tant qu'il est false, un échec doit laisser zéro objet durable. */
    let artifactCreated = false
    // Objet mutable : une variable locale serait figée par le narrowing de TS
    // alors que la phase change dans les callbacks du producteur.
    const state: { phase: BackupRunPhase } = { phase: "resolving" }

    const onPhase = async (next: BackupRunPhase) => {
      state.phase = next
      await this.store.setPhase(run.id, next)
    }

    try {
      await onPhase("resolving")

      const prereq = input.strategy.verifyPrereqs(input.target)
      if (!prereq.ok) {
        throw new BackupError(
          "prereq_failed",
          prereq.reason ?? "prérequis non satisfaits",
        )
      }
      const plan = input.strategy.backup(input.target)

      await onPhase("extracting")
      produced = await input.producer.produce({
        runId: run.id,
        artifactId,
        stagingPrefix,
        destination: input.destination,
        target: input.target,
        plan,
        onPhase,
      })

      await onPhase("verifying")
      // Vérification RÉELLE et distante via le StorageProvider : jamais un
      // simple local == local (reviewer #3). La taille est toujours vérifiée ;
      // le checksum l'est quand le backend le supporte. Tout downgrade est
      // consigné explicitement dans le manifest (jamais silencieux).
      if (!input.provider) {
        throw new BackupError("verify_failed", "aucun storage provider disponible")
      }
      let verificationMode = input.verification
      let verificationDowngraded = false
      const stat = await input.provider.stat(produced.payloadKey)
      if (!stat) throw new BackupError("verify_failed", "payload absent du stockage")
      if (stat.size !== produced.sizeBytes) {
        throw new BackupError(
          "verify_failed",
          `taille distante ${stat.size} ≠ ${produced.sizeBytes}`,
        )
      }
      const remoteHash = await input.provider.hash(produced.payloadKey)
      if (input.verification === "checksum") {
        if (remoteHash && remoteHash !== produced.checksumSha256) {
          throw new BackupError("checksum_mismatch", "checksum distant différent")
        }
        // Backend sans hash natif : on rétrograde vers la vérification de
        // taille (déjà effectuée ci-dessus). Le downgrade est EXPLICITE.
        if (!remoteHash) {
          verificationDowngraded = true
          verificationMode = "size"
        }
      }

      await onPhase("committing")
      const finalPrefix = artifactPrefix(
        input.destination.basePath,
        input.projectSlug,
        input.target.name,
        artifactId,
      )
      const finalKey = `${finalPrefix}/${produced.payloadFileName}`

      // Promotion via le StorageProvider : c'est lui qui choisit et exécute le
      // mécanisme (atomic-rename vs copy-verify-delete) selon SES capacités, et
      // renvoie le mode RÉELLEMENT utilisé — consigné tel quel (reviewer #4).
      // Le préfixe final est unique par artifact (artifactId UUID) : on le
      // mémorise AVANT la promotion pour pouvoir annuler une promotion
      // partielle (copie réussie puis vérification en échec, par exemple).
      committedPrefix = finalPrefix
      const commitMode = await input.provider.commitPayload({
        stagingKey: produced.payloadKey,
        finalKey,
        expectedChecksum: produced.checksumSha256,
        expectedSizeBytes: produced.sizeBytes,
      })

      const manifest = buildManifest({
        artifactId,
        runId: run.id,
        target: {
          nodeId: input.target.nodeId,
          name: input.target.name,
          kind: input.target.kind,
        },
        source: {
          engine: input.target.engine,
          engineVersion: input.target.engineVersion,
          database: input.target.database,
        },
        strategy: {
          id: input.strategy.id,
          version: input.strategy.version,
          tool: plan.tool,
          toolVersion: plan.toolVersion,
        },
        payload: {
          path: produced.payloadFileName,
          format: plan.payloadFormat,
          sizeBytes: produced.sizeBytes,
        },
        checksumSha256: produced.checksumSha256,
        encryptionMode: "none",
        verificationMode,
        verificationDowngraded,
        commitMode,
        restore: {
          strategyId: input.strategy.id,
          command: plan.restoreCommand,
          requires: plan.requires,
        },
      })

      // Le manifest est écrit EN DERNIER : sa présence vaut commit.
      await input.provider.put(
        `${finalPrefix}/${CHECKSUM_FILE}`,
        Buffer.from(`${produced.checksumSha256}  ${produced.payloadFileName}\n`, "utf8"),
      )
      await input.provider.put(
        `${finalPrefix}/${MANIFEST_FILE}`,
        Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      )

      const artifact = await this.store.createArtifact({
        runId: run.id,
        targetId: input.targetId,
        destinationId: input.destinationId,
        storageKey: finalPrefix,
        manifestJson: manifest,
        payloadFormat: plan.payloadFormat,
        checksumSha256: produced.checksumSha256,
        sizeBytes: produced.sizeBytes,
        engine: input.target.engine,
        engineVersion: input.target.engineVersion,
        strategyId: input.strategy.id,
        formatVersion: manifest.formatVersion,
      })
      artifactCreated = true

      await onPhase("done")
      await this.store.complete(run.id, produced.sizeBytes)

      return {
        ok: true,
        runId: run.id,
        artifactId: artifact.id,
        sizeBytes: produced.sizeBytes,
      }
    } catch (error) {
      const code =
        error instanceof BackupError
          ? error.code
          : error instanceof StorageProviderError
            ? error.code
            : state.phase === "verifying"
              ? "verify_failed"
              : "backup_failed"
      const message = scrubSecrets(
        error instanceof Error ? error.message : String(error),
      )
      // Nettoyage AVANT la persistance d'échec : un `store.fail()` en erreur ne
      // doit pas empêcher la suppression des objets distants.
      //
      // Rollback post-commit : si le payload a été promu mais que l'artifact
      // n'existe pas en base, le préfixe final est supprimé (manifest d'abord).
      // Invariant : pas de manifest → pas d'artifact valide.
      if (committedPrefix && !artifactCreated && input.provider) {
        await cleanupPrefix(input.provider, committedPrefix)
      }
      // Le staging est nettoyé même si le producteur a échoué avant de rendre
      // la main : le préfixe appartient au moteur, pas au producteur.
      if (input.producer.cleanup) {
        await input.producer.cleanup(stagingPrefix).catch(() => undefined)
      } else if (input.provider) {
        await cleanupPrefix(input.provider, stagingPrefix)
      }
      await this.store.fail(run.id, code, message)
      return { ok: false, runId: run.id, errorCode: code }
    }
  }
}
