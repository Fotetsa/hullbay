import { describe, expect, it, vi } from "vitest"
import type { DockerEngineService } from "../../docker-engine/service"
import { SwarmTaskExecutor } from "../engine/swarm-task"

function engine(tasks: unknown[]) {
  return {
    createService: vi.fn(async () => ({ ID: "svc_1" })),
    listServiceTasks: vi.fn(async () => tasks),
    serviceLogs: vi.fn(async () => "logs"),
    removeService: vi.fn(async () => undefined),
  }
}

const input = {
  runId: "run_1",
  suffix: "transfer",
  script: "true",
  image: "hullbay-backup-runner:test",
  timeoutSec: 1,
}

describe("SwarmTaskExecutor", () => {
  it("classe un dépassement de délai en timeout et supprime le service", async () => {
    const fake = engine([{ Status: { State: "running" } }])
    const executor = new SwarmTaskExecutor(fake as unknown as DockerEngineService)

    await expect(executor.run({ ...input, timeoutSec: 0 })).rejects.toMatchObject({
      code: "timeout",
    })
    expect(fake.removeService).toHaveBeenCalledWith("svc_1")
  })

  it("retourne les logs d'un task réussi", async () => {
    const fake = engine([{ Status: { State: "complete" } }])
    const executor = new SwarmTaskExecutor(fake as unknown as DockerEngineService)

    await expect(executor.run(input)).resolves.toBe("logs")
    expect(fake.removeService).toHaveBeenCalledWith("svc_1")
  })

  it("joint le code de sortie et les logs à un échec de task", async () => {
    const fake = engine([{ Status: { State: "failed" }, ContainerStatus: { ExitCode: 3 } }])
    const executor = new SwarmTaskExecutor(fake as unknown as DockerEngineService)

    const error = await executor.run(input).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "task_failed", exitCode: 3, logs: "logs" })
  })
})
