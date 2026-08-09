import { describe, it, expect, beforeEach, vi } from "vitest"
import { DockerEngineService } from "../service"

function makeService() {
  const update = vi.fn()
  const docker = {
    listServices: vi.fn(async () => [
      {
        ID: "svc-api",
        Spec: {
          Name: "hullbaytest_api",
          TaskTemplate: { ContainerSpec: { Image: "ghcr.io/fotetsa/hullbay/api:1.2.2" } },
        },
      },
    ]),
    getService: vi.fn((id: string) => ({
      inspect: async () => ({
        Version: { Index: 5 },
        Spec: {
          Name: "hullbaytest_api",
          TaskTemplate: { ContainerSpec: { Image: "ghcr.io/fotetsa/hullbay/api:1.2.2" } },
        },
      }),
      update,
    })),
  }
  return { docker, update }
}

describe("DockerEngineService.updateSystemServiceImage", () => {
  beforeEach(() => {
    process.env.GHCR_OWNER = "fotetsa"
    process.env.IMAGE_REGISTRY = "ghcr.io"
  })

  it("force le rollout (ForceUpdate) même si l'image est identique à l'actuelle", async () => {
    const { docker, update } = makeService()
    const svc = new DockerEngineService(docker as never)

    // Même tag que celui déjà déployé : Swarm ne recréerait PAS la tâche sans
    // ForceUpdate → l'API ne redémarre pas → finalisation au boot jamais faite.
    await svc.updateSystemServiceImage("api", "ghcr.io/fotetsa/hullbay/api:1.2.2")

    expect(docker.getService).toHaveBeenCalledWith("svc-api")
    const updateArgs = update.mock.calls[0]?.[0] as {
      TaskTemplate?: { ContainerSpec?: { Image?: string }; ForceUpdate?: number }
    }
    expect(updateArgs?.TaskTemplate?.ContainerSpec?.Image).toBe("ghcr.io/fotetsa/hullbay/api:1.2.2")
    expect(updateArgs?.TaskTemplate?.ForceUpdate).toBe(1)
  })

  it("refuse une image qui n'est pas une image hullbay du bon composant", async () => {
    const { docker } = makeService()
    const svc = new DockerEngineService(docker as never)

    await expect(
      svc.updateSystemServiceImage("api", "ghcr.io/fotetsa/hullbay/web:1.2.2"),
    ).rejects.toThrow("image cible")
    await expect(
      svc.updateSystemServiceImage("api", "docker.io/library/nginx:latest"),
    ).rejects.toThrow("image cible")
  })
})
