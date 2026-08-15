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