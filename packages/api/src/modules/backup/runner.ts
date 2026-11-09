import type { Placement, Resources } from "@hullbay/shared"
import type { DockerEngineService } from "../docker-engine/service"
import type { ArtifactProducer, ProducedArtifact } from "./engine/lifecycle"
import { BackupError } from "./engine/lifecycle"
import { SwarmTaskExecutor, type TaskSecret } from "./engine/swarm-task"
import { scrubSecrets } from "./storage/remote-string"
import type { StagingSink } from "./storage/types"
import type { ResolvedDestination } from "./storage/registry"
import type { StrategyPlan, StrategyTarget } from "./strategies/types"

/**
 * Producteur Swarm one-shot (extraction + staging put).
 *
 * Le runner ne connaît PAS rclone : la remote-string, le secret de transport et
 * la commande d'upload lui sont fournis par le `StagingSink` (l'adapter de
 * stockage). Il ne compose que `extraction | <commande d'upload>`.
 *
 * Contraintes (Direction + plan) :
 *  - jamais de `docker exec` : un service éphémère par étape, supprimé ensuite ;
 *  - credentials uniquement en Docker Secrets montés en fichiers ;
 *  - aucun volume d'archive : extraction → gzip → upload streamé.
 */

const RESULT_MARKER = "HULLBAY_BACKUP_RESULT"

export interface SwarmRunnerDeps {
  engine: DockerEngineService
  /** Adapter de stockage : fournit la commande d'upload et les secrets. */
  storage: StagingSink
  image: string
  networkName: string
  volumeName?: string
  placement?: Placement
  resources?: Resources
  timeoutSec: number
  pollMs?: number
}

function secretName(prefix: string, runId: string): string {
  return `${prefix}_${runId}`.slice(0, 60)
}

export class SwarmBackupRunner implements ArtifactProducer {
  private readonly tasks: SwarmTaskExecutor

  constructor(private readonly deps: SwarmRunnerDeps) {
    this.tasks = new SwarmTaskExecutor(deps.engine)
  }

  async produce(ctx: {
    runId: string
    artifactId: string
    stagingPrefix: string
    destination: ResolvedDestination
    target: StrategyTarget
    plan: StrategyPlan
    onPhase: (phase: "transferring") => Promise<void>
  }): Promise<ProducedArtifact> {
    const payloadFile = `payload.${ctx.plan.payloadFormat}`
    const payloadKey = `${ctx.stagingPrefix}/${payloadFile}`
    const created: string[] = []

    try {
      const remoteSecret = secretName("backup_remote", ctx.runId)
      await this.deps.engine.upsertSecret(
        remoteSecret,
        this.deps.storage.remoteString(),
        { "bozando.backupRunId": ctx.runId },
      )
      created.push(remoteSecret)

      const secrets: TaskSecret[] = [
        { secretName: remoteSecret, target: "/run/secrets/backup_remote" },
      ]
      if (ctx.target.passwordSecretRef) {
        secrets.push({
          secretName: ctx.target.passwordSecretRef,
          target: "/run/secrets/db_password",
        })
      }
      const transport = this.deps.storage.transportSecret()
      if (transport) {
        const keySecret = secretName("backup_key", ctx.runId)
        await this.deps.engine.upsertSecret(keySecret, transport.material, {
          "bozando.backupRunId": ctx.runId,
        })
        created.push(keySecret)
        secrets.push({ secretName: keySecret, target: transport.target })
      }

      const script = [
        "set -euo pipefail",
        'REMOTE="$(cat /run/secrets/backup_remote)"',
        "mkdir -p /tmp/work",
        ctx.plan.prereqScript ?? "",
        "{",
        ctx.plan.extractionScript,
        "} | tee \\",
        "  >(sha256sum | awk '{print $1}' > /tmp/work/checksum) \\",
        "  >(wc -c | tr -d ' ' > /tmp/work/size) \\",
        `  | ${this.deps.storage.stagingUploadScript(payloadKey)}`,
        "wait",
        `printf '${RESULT_MARKER} %s %s\\n' "$(cat /tmp/work/size)" "$(cat /tmp/work/checksum)"`,
      ]
        .filter((line) => line.length > 0)
        .join("\n")

      await ctx.onPhase("transferring")
      const logs = await this.tasks.run({
        runId: ctx.runId,
        suffix: "transfer",
        script,
        env: ctx.plan.env,
        secrets,
        networkName: this.deps.networkName,
        volumeName: this.deps.volumeName,
        image: this.deps.image,
        placement: this.deps.placement,
        resources: this.deps.resources,
        timeoutSec: this.deps.timeoutSec,
        pollMs: this.deps.pollMs,
      })

      const parsed = this.parseResult(logs)
      if (!parsed) {
        throw new BackupError(
          "transfer_failed",
          "le task n'a pas produit de résultat exploitable",
        )
      }
      return { payloadKey, payloadFileName: payloadFile, ...parsed }
    } catch (error) {
      throw this.classifyTransferFailure(error)
    } finally {
      await this.removeSecrets(created)
    }
  }

  /**
   * Le checksum est calculé pendant le transfert (tee). La vérification
   * distante réelle et la promotion (commit) sont déléguées au StorageProvider
   * par le lifecycle — le runner ne possède plus de lifecycle de stockage
   * rclone caché (reviewer #2/#3/#4). Ici, seul le staging put fusionné avec
   * l'extraction reste du ressort du producteur (contrainte de streaming).
   */

  // ── Interne ────────────────────────────────────────────────────────────────

  /**
   * Traduit un échec de task en code métier stable. Le classement se fait sur
   * le code de sortie et la trace, jamais sur le message brut (qui peut contenir
   * des identifiants de connexion → scrub avant persistance).
   */
  private classifyTransferFailure(error: unknown): unknown {
    if (!(error instanceof BackupError) || error.code !== "task_failed") return error
    const logs = scrubSecrets(error.logs ?? "")
    if (error.exitCode === 3) {
      return new BackupError("prereq_failed", "prérequis du moteur non satisfaits", { logs })
    }
    if (
      /rclone|Failed to (?:create|copy|open|stat|delete|move)|dial tcp|no such host|connection refused|i\/o timeout|context deadline exceeded/i.test(
        logs,
      )
    ) {
      return new BackupError("destination_unreachable", "destination de sauvegarde injoignable", {
        logs,
      })
    }
    return new BackupError("transfer_failed", error.message, { logs })
  }

  private async removeSecrets(names: string[]): Promise<void> {
    for (const name of names) {
      await this.deps.engine.removeSecret(name).catch(() => undefined)
    }
  }

  private parseResult(logs: string): { sizeBytes: number; checksumSha256: string } | null {
    const line = logs
      .split(/\r?\n/)
      .reverse()
      .find((candidate) => candidate.includes(RESULT_MARKER))
    if (!line) return null
    const [, size, checksum] = line.trim().split(/\s+/)
    if (!size || !checksum) return null
    const sizeBytes = Number.parseInt(size, 10)
    if (!Number.isFinite(sizeBytes) || !/^[0-9a-f]{64}$/i.test(checksum)) return null
    return { sizeBytes, checksumSha256: checksum.toLowerCase() }
  }
}
