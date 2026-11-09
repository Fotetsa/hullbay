import { describe, expect, it, vi } from "vitest"
import type { DockerEngineService } from "../../../docker-engine/service"
import { sweepOrphanBackupResources } from "../orphan-sweep"

describe("sweepOrphanBackupResources (#16)", () => {
  it("supprime les services/secrets sans run RUNNING, préserve les actifs", async () => {
    const engine = {
      listBackupServices: async () => [
        { ID: "svc_active", Spec: { Labels: { "bozando.backupRunId": "run_active" } } },
        { ID: "svc_orphan", Spec: { Labels: { "bozando.backupRunId": "run_orphan" } } },
        { ID: "svc_unlabeled", Spec: { Labels: {} } },
      ],
      listBackupSecrets: async () => [
        { id: "s1", name: "sec_active", labels: { "bozando.backupRunId": "run_active" } },
        { id: "s2", name: "sec_orphan", labels: { "bozando.backupRunId": "run_orphan" } },
      ],
      removeService: vi.fn(async () => undefined),
      removeSecret: vi.fn(async () => undefined),
    }

    const result = await sweepOrphanBackupResources(
      engine as unknown as DockerEngineService,
      new Set(["run_active"]),
    )

    expect(engine.removeService).toHaveBeenCalledWith("svc_orphan")
    expect(engine.removeService).toHaveBeenCalledWith("svc_unlabeled")
    expect(engine.removeService).not.toHaveBeenCalledWith("svc_active")
    expect(engine.removeSecret).toHaveBeenCalledWith("sec_orphan")
    expect(engine.removeSecret).not.toHaveBeenCalledWith("sec_active")
    expect(result).toEqual({ services: 2, secrets: 1 })
  })
})
