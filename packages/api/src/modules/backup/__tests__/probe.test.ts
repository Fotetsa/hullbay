import { describe, expect, it, vi } from "vitest"
import type { DockerEngineService } from "../../docker-engine/service"
import { probeDestination } from "../storage/swarm-probe"
import type { ResolvedDestination } from "../storage/registry"

function fakeEngine(logs: string) {
  return {
    upsertSecret: vi.fn(async () => "id"),
    removeSecret: vi.fn(async () => undefined),
    createService: vi.fn(async () => ({ ID: "svc_probe" })),
    listServiceTasks: vi.fn(async () => [{ Status: { State: "complete" } }]),
    serviceLogs: vi.fn(async () => logs),
    removeService: vi.fn(async () => undefined),
  } as unknown as DockerEngineService
}

const s3: ResolvedDestination = {
  protocol: "s3",
  basePath: "hullbay",
  config: {
    protocol: "s3",
    bucket: "b",
    accessKeyId: "k",
    secretAccessKey: "s",
    useTls: true,
    pathStyle: false,
  },
}

describe("probeDestination", () => {
  it("lit la matrice de capacités renvoyée par le task", async () => {
    const engine = fakeEngine(
      "HULLBAY_PROBE read=true write=true delete=true checksum=true move=false",
    )
    const result = await probeDestination({
      engine: engine as unknown as DockerEngineService,
      image: "runner:latest",
      destination: s3,
    })
    expect(result.ok).toBe(true)
    expect(result.capabilities).toMatchObject({
      read: true,
      write: true,
      delete: true,
      checksum: true,
      move: false,
      atomicCommit: false,
    })
  })

  it("signale une destination en lecture seule", async () => {
    const engine = fakeEngine(
      "HULLBAY_PROBE read=true write=false delete=false checksum=false move=false",
    )
    const result = await probeDestination({
      engine: engine as unknown as DockerEngineService,
      image: "runner:latest",
      destination: s3,
    })
    expect(result.ok).toBe(false)
    expect(result.capabilities.write).toBe(false)
  })

  it("monte la clé SSH dans un secret, jamais dans la remote-string", async () => {
    const engine = fakeEngine(
      "HULLBAY_PROBE read=true write=true delete=true checksum=true move=true",
    )
    const sftp: ResolvedDestination = {
      protocol: "sftp",
      basePath: "hullbay",
      config: {
        protocol: "sftp",
        host: "storage.example",
        port: 22,
        username: "backup",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      },
    }
    await probeDestination({
      engine: engine as unknown as DockerEngineService,
      image: "runner:latest",
      destination: sftp,
    })

    const calls = (engine.upsertSecret as ReturnType<typeof vi.fn>).mock.calls
    const remoteCall = calls.find((c) => String(c[0]).startsWith("backup_probe_") && String(c[0]).includes("key") === false)
    expect(remoteCall?.[1]).toContain("key_file=/run/secrets/backup_key")
    expect(remoteCall?.[1]).not.toContain("PRIVATE KEY")
    expect(calls.some((c) => String(c[0]).includes("probe_key"))).toBe(true)
    expect(engine.removeSecret).toHaveBeenCalledTimes(2)
  })
})
