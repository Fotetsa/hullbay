import { describe, it, expect, beforeEach, vi } from "vitest"

const { mockDocker, mockFindUniqueOrThrow, mockEnsureTunnel } = vi.hoisted(() => ({
  // function (pas arrow) : dockerode est instancié via `new Docker(params)`
  mockDocker: vi.fn(function (params: Record<string, unknown>) {
    return { params, opts: params }
  }),
  mockFindUniqueOrThrow: vi.fn(),
  mockEnsureTunnel: vi.fn(),
}))

vi.mock("dockerode", () => ({ default: mockDocker }))
vi.mock("../../../lib/prisma", () => ({
  prisma: { cluster: { findUniqueOrThrow: mockFindUniqueOrThrow } },
}))
vi.mock("../../../lib/ssh-tunnel", () => ({ ensureTunnel: mockEnsureTunnel }))

import { getDockerForCluster, invalidateDockerClient } from "../client"

function cluster(overrides: Partial<{
  id: string;
  isDefault: boolean;
  dockerHost: string;
}> = {}) {
  return {
    id: "cluster-1",
    isDefault: true,
    dockerHost: "tcp://socket-proxy:2375",
    ...overrides,
  }
}

describe("docker-engine/client — protocol explicite", () => {
  beforeEach(() => {
    // state module interne (cache registry) : module neuf par test
    vi.resetModules()
    vi.clearAllMocks()
  })

  it("cluster défaut tcp:// → Docker({ host, port, protocol: 'http' })", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster())
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledTimes(1)
    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ host: "socket-proxy", port: 2375, protocol: "http" }),
    )
    expect(mockEnsureTunnel).not.toHaveBeenCalled()
  })

  it("cluster défaut http:// → protocol 'http'", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ dockerHost: "http://proxy:2375" }))
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "http", port: 2375 }),
    )
  })

  it("cluster défaut https:// → protocol 'https' (ni socket Unix, ni rejet silencieux)", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ dockerHost: "https://daemon:2376" }))
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ host: "daemon", port: 2376, protocol: "https" }),
    )
  })

  it("cluster défaut https:// sans port → port par défaut TLS 2376", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ dockerHost: "https://daemon" }))
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ port: 2376, protocol: "https" }),
    )
  })

  it("cluster non-défaut → tunnel SSH, protocol 'http', adresse locale", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ isDefault: false }))
    mockEnsureTunnel.mockResolvedValue(54321)
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockEnsureTunnel).toHaveBeenCalledWith("cluster-1", 2375)
    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 54321, protocol: "http" }),
    )
  })

  it("cluster non-défaut https:// → tunnel mais protocol 'https' conservé", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ isDefault: false, dockerHost: "https://daemon:2376" }))
    mockEnsureTunnel.mockResolvedValue(54321)
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockEnsureTunnel).toHaveBeenCalledWith("cluster-1", 2376)
    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 54321, protocol: "https" }),
    )
  })

  it("dockerHost vide → fallback socket Unix", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster({ dockerHost: "" }))
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/var/run/docker.sock" }),
    )
  })

  it("met en cache : un second appel ne reconstruit pas le client", async () => {
    mockFindUniqueOrThrow.mockResolvedValue(cluster())
    const mod = await import("../client")
    await mod.getDockerForCluster("cluster-1")
    await mod.getDockerForCluster("cluster-1")

    expect(mockDocker).toHaveBeenCalledTimes(1)
  })
})

describe("getDockerForCluster — cache + accès selon le type de cluster (P2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateDockerClient("c1")
  })

  it("cluster default → socket/parse direct, PAS de tunnel", async () => {
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: true,
      dockerHost: "",
      caddyAdminUrl: "",
    })

    const client = await getDockerForCluster("c1")

    expect(mockEnsureTunnel).not.toHaveBeenCalled()
    expect(client).toBeDefined()
  })

  it("cluster non-default → client par tunnel (127.0.0.1:port local)", async () => {
    mockEnsureTunnel.mockResolvedValue(5000)
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: false,
      dockerHost: "tcp://10.99.0.11:2375",
      caddyAdminUrl: "http://10.99.0.11:2019",
    })

    const client = await getDockerForCluster("c1")

    expect(mockEnsureTunnel).toHaveBeenCalledWith("c1", 2375)
    expect(client).toBeDefined()
  })

  it("client mise en cache → 1 seule requête cluster", async () => {
    mockEnsureTunnel.mockResolvedValue(5000)
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: false,
      dockerHost: "tcp://10.99.0.11:2375",
      caddyAdminUrl: "http://10.99.0.11:2019",
    })

    const first = await getDockerForCluster("c1")
    const second = await getDockerForCluster("c1")

    expect(first).toBe(second)
    expect(mockFindUniqueOrThrow).toHaveBeenCalledTimes(1)
    expect(mockEnsureTunnel).toHaveBeenCalledTimes(1)
  })

  it("invalidateDockerClient purge le cache → re-construction", async () => {
    mockEnsureTunnel.mockResolvedValue(5000)
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: false,
      dockerHost: "tcp://10.99.0.11:2375",
      caddyAdminUrl: "http://10.99.0.11:2019",
    })

    const before = await getDockerForCluster("c1")
    invalidateDockerClient("c1")
    const after = await getDockerForCluster("c1")

    expect(before).not.toBe(after)
    expect(mockFindUniqueOrThrow).toHaveBeenCalledTimes(2)
  })

  it("appels concurrents → un seul client construit (Promise partagée)", async () => {
    invalidateDockerClient("c1")
    mockEnsureTunnel.mockResolvedValue(5000)
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: false,
      dockerHost: "tcp://10.99.0.11:2375",
      caddyAdminUrl: "http://10.99.0.11:2019",
    })

    const [a, b] = await Promise.all([
      getDockerForCluster("c1"),
      getDockerForCluster("c1"),
    ])

    expect(a).toBe(b)
    expect(mockFindUniqueOrThrow).toHaveBeenCalledTimes(1)
    expect(mockEnsureTunnel).toHaveBeenCalledTimes(1)
  })

  it("échec concurrent → Promise partagée purgée, un nouvel appel retente (anti-poison)", async () => {
    invalidateDockerClient("c1")
    mockFindUniqueOrThrow.mockRejectedValue(new Error("accès refusé"))

    const [r1, r2] = await Promise.allSettled([
      getDockerForCluster("c1"),
      getDockerForCluster("c1"),
    ])
    expect(r1.status).toBe("rejected")
    expect(r2.status).toBe("rejected")

    // Promise partagée même en échec : un seul build lancé (pré-fix → 2 findUnique)
    expect(mockFindUniqueOrThrow).toHaveBeenCalledTimes(1)

    // Défaillance non mise en cache : un nouvel appel relance la construction
    mockFindUniqueOrThrow.mockResolvedValue({
      id: "c1",
      isDefault: false,
      dockerHost: "tcp://10.99.0.11:2375",
      caddyAdminUrl: "http://10.99.0.11:2019",
    })
    mockEnsureTunnel.mockResolvedValue(5000)
    const client = await getDockerForCluster("c1")

    expect(client).toBeDefined()
    expect(mockFindUniqueOrThrow).toHaveBeenCalledTimes(2)
  })
})