import { describe, it, expect, beforeEach, vi } from "vitest"
import { DockerEngineService } from "../service"
import type { ContainerConfig } from "@hullbay/shared"

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

describe("DockerEngineService.buildServiceSpec — restartPolicy du nœud → Condition Swarm (P4)", () => {
  /** Config conteneur minimale mais complète pour buildServiceSpec. */
  const baseConfig = (over: Partial<ContainerConfig> = {}): ContainerConfig => ({
    image: "nginx",
    tag: "latest",
    env: {},
    secrets: [],
    ports: [],
    restartPolicy: "unless-stopped",
    replicas: 1,
    updateParallelism: 1,
    updateDelaySec: 5,
    ...over,
  })

  async function specFor(config: ContainerConfig): Promise<{ TaskTemplate: { RestartPolicy: { Condition?: string } } }> {
    const createService = vi.fn(async (spec: unknown) => ({ id: "svc-x", ...(spec as object) }))
    const docker = {
      createService,
      listSecrets: vi.fn(async () => []),
      listServices: vi.fn(async () => []),
    }
    const svc = new DockerEngineService(docker as never)
    await svc.createService("s", config, {})
    return createService.mock.calls[0]?.[0] as never
  }

  it("défaut unless-stopped → Condition 'any' (comportement historique)", async () => {
    expect((await specFor(baseConfig())).TaskTemplate.RestartPolicy.Condition).toBe("any")
  })

  it("always → Condition 'any'", async () => {
    expect((await specFor(baseConfig({ restartPolicy: "always" }))).TaskTemplate.RestartPolicy.Condition).toBe("any")
  })

  it("on-failure → Condition 'on-failure'", async () => {
    expect((await specFor(baseConfig({ restartPolicy: "on-failure" }))).TaskTemplate.RestartPolicy.Condition).toBe("on-failure")
  })

  it("no → Condition 'none' (one-shot, anti boucle hello-world sur exit 0)", async () => {
    expect((await specFor(baseConfig({ restartPolicy: "no" }))).TaskTemplate.RestartPolicy.Condition).toBe("none")
  })
})

describe("DockerEngineService.connectContainerToNetwork (P5)", () => {
  function makeService(connectImpl: () => Promise<unknown>) {
    const connect = vi.fn(connectImpl)
    const docker = { getNetwork: vi.fn(() => ({ connect })) }
    return { docker, connect }
  }

  it("rattache le conteneur au réseau overlay", async () => {
    const { docker, connect } = makeService(async () => ({}))
    const svc = new DockerEngineService(docker as never)
    await svc.connectContainerToNetwork("hullbay-caddy", "boz_system")
    expect(connect).toHaveBeenCalledWith({ Container: "hullbay-caddy" })
  })

  it("tolère « already connected » → idempotent (re-déploiement)", async () => {
    const { docker } = makeService(async () => {
      throw new Error("container already connected to network")
    })
    const svc = new DockerEngineService(docker as never)
    await expect(
      svc.connectContainerToNetwork("hullbay-caddy", "boz_system"),
    ).resolves.toBeUndefined()
  })

  it("relaie les autres erreurs (réseau introuvable…)", async () => {
    const { docker } = makeService(async () => {
      throw new Error("network boz_foo not found")
    })
    const svc = new DockerEngineService(docker as never)
    await expect(
      svc.connectContainerToNetwork("hullbay-caddy", "boz_foo"),
    ).rejects.toThrow("network boz_foo not found")
  })
})
