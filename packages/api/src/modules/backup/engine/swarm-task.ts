import { randomBytes } from "node:crypto"
import type { ContainerConfig, Placement, Resources } from "@hullbay/shared"
import type { DockerEngineService } from "../../docker-engine/service"
import { BackupError } from "./lifecycle"

/**
 * Exécution d'un task Swarm one-shot.
 *
 * Véhicule unique du domaine backup (transfert, commit, probe) : aucun
 * `docker exec`, aucun daemon permanent. Le service est toujours supprimé.
 */

export interface TaskSecret {
  secretName: string
  target: string
}

export interface RunTaskInput {
  runId: string
  suffix: string
  script: string
  env?: Record<string, string>
  secrets?: TaskSecret[]
  networkName?: string
  volumeName?: string
  image: string
  placement?: Placement
  resources?: Resources
  timeoutSec: number
  pollMs?: number
}

interface TaskLike {
  Status?: { State?: string }
  DesiredState?: string
  ContainerStatus?: { ExitCode?: number }
}

function splitImage(image: string): { image: string; tag: string } {
  const lastColon = image.lastIndexOf(":")
  const lastSlash = image.lastIndexOf("/")
  if (lastColon > lastSlash) {
    return { image: image.slice(0, lastColon), tag: image.slice(lastColon + 1) }
  }
  return { image, tag: "latest" }
}

export class SwarmTaskExecutor {
  constructor(private readonly engine: DockerEngineService) {}

  async run(input: RunTaskInput): Promise<string> {
    const serviceName =
      `backup_${input.runId}_${input.suffix}_${randomBytes(2).toString("hex")}`.slice(0, 60)
    const { image, tag } = splitImage(input.image)
    const secrets = input.secrets ?? []
    const config: ContainerConfig = {
      image,
      tag,
      pullPolicy: "IfNotPresent",
      env: {
        ...(input.env ?? {}),
        ...(secrets.some((s) => s.target === "/run/secrets/db_password")
          ? { DB_PASSWORD_FILE: "/run/secrets/db_password" }
          : {}),
      },
      secrets,
      cmd: ["/bin/bash", "-c", input.script],
      ports: [],
      restartPolicy: "no",
      resources: input.resources,
      placement: input.placement,
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 0,
    }

    const labels = {
      "bozando.backup": "true",
      "bozando.backupRunId": input.runId,
      "bozando.nodeType": "backup",
    }
    const mounts = input.volumeName
      ? [{ volumeName: input.volumeName, target: "/data", readOnly: true }]
      : []

    const service = await this.engine.createService(
      serviceName,
      config,
      labels,
      input.networkName ? [input.networkName] : [],
      mounts,
    )
    const serviceId =
      (service as { ID?: string }).ID ??
      (service as { id?: string }).id ??
      serviceName

    try {
      await this.waitForTask(serviceId, input.timeoutSec, input.pollMs ?? 1000)
      return await this.engine.serviceLogs(serviceId, 500)
    } finally {
      await this.engine.removeService(serviceId).catch(() => undefined)
    }
  }

  private async waitForTask(
    serviceId: string,
    timeoutSec: number,
    pollMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const tasks = (await this.engine.listServiceTasks(serviceId)) as TaskLike[]
      const terminal = tasks.find((task) =>
        ["complete", "failed", "rejected"].includes(task.Status?.State ?? ""),
      )
      if (terminal) {
        if (terminal.Status?.State !== "complete") {
          // Trace bornée : le runner classe l'échec (prérequis, destination
          // injoignable…) à partir des logs, sans que l'exécuteur ne connaisse
          // les outils de sauvegarde.
          const logs = await this.engine.serviceLogs(serviceId, 120).catch(() => "")
          throw new BackupError("task_failed", `task ${terminal.Status?.State}`, {
            logs,
            exitCode: terminal.ContainerStatus?.ExitCode,
          })
        }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new BackupError("timeout", `task non terminé après ${timeoutSec}s`)
  }
}
