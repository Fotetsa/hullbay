import { describe, it, expect, beforeEach, vi } from "vitest"
import { PassThrough } from "node:stream"
import net from "node:net"

const { mockSession, mockConnect, mockFindFirst } = vi.hoisted(() => {
  const session = {
    dispose: vi.fn(),
    forwardOut: vi.fn(async () => new PassThrough()),
    onClose: vi.fn(),
    onError: vi.fn(),
  }
  return {
    mockSession: session,
    mockConnect: vi.fn(async () => session),
    mockFindFirst: vi.fn(),
  }
})

vi.mock("../prisma", () => ({
  prisma: { server: { findFirst: mockFindFirst } },
}))

vi.mock("../ssh", () => ({
  SshSession: { connect: mockConnect },
}))

vi.mock("../../modules/auth/crypto", () => ({
  decryptSecret: (payload: string) => payload,
}))

function manager(name: string) {
  return {
    id: "mgr-1",
    name,
    role: "manager" as const,
    status: "ready" as const,
    host: "10.0.0.5",
    port: 22,
    user: "root",
    privateKeyEnc: "clé-chiffrée",
    hostKeyFp: "sha256:deadbeef",
  }
}

async function connectExpectRefused(port: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port })
      sock.once("connect", () => {
        sock.destroy()
        resolve(false)
      })
      sock.once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "ECONNREFUSED")
      })
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`le port ${port} accepte encore des connexions`)
}

describe("ssh-tunnel — cycle de vie", () => {
  let ensureTunnel: typeof import("../ssh-tunnel").ensureTunnel
  let closeTunnel: typeof import("../ssh-tunnel").closeTunnel

  beforeEach(async () => {
    // state module interne (Map tunnels) : module neuf par test
    vi.resetModules()
    vi.clearAllMocks()
    const mod = await import("../ssh-tunnel")
    ensureTunnel = mod.ensureTunnel
    closeTunnel = mod.closeTunnel
    mockFindFirst.mockResolvedValue(manager("mgr"))
  })

  it("ouvre un tunnel et fournit un port local joignable", async () => {
    const port = await ensureTunnel("cluster-1", 2375)

    expect(port).toBeGreaterThan(0)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clusterId: "cluster-1", role: "manager", status: "ready" } }),
    )
  })

  it("réutilise un tunnel existant (idempotent)", async () => {
    const first = await ensureTunnel("cluster-1", 2375)
    const second = await ensureTunnel("cluster-1", 2375)

    expect(second).toBe(first)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it("appels concurrents → une seule session et le même port", async () => {
    const [first, second] = await Promise.all([
      ensureTunnel("cluster-1", 2375),
      ensureTunnel("cluster-1", 2375),
    ])

    expect(first).toBe(second)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it("course en vol : pending partagé, aucune connexion double", async () => {
    let release!: (s: unknown) => void
    const gated = new Promise((resolve) => {
      release = resolve
    })
    vi.mocked(mockConnect).mockImplementationOnce(() => gated as never)

    const a = ensureTunnel("cluster-1", 2375)
    const b = ensureTunnel("cluster-1", 2375)

    // la session a déjà reçu sa 1ère connexion (gated, en vol) : pas de 2e lancée
    await Promise.resolve()
    expect(mockConnect).toHaveBeenCalledTimes(1)

    release(mockSession)
    const [pa, pb] = await Promise.all([a, b])

    expect(pa).toBe(pb)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it("nettoyage quand la session SSH se ferme (close)", async () => {
    const port = await ensureTunnel("cluster-1", 2375)

    const closeCb = vi.mocked(mockSession.onClose).mock.calls[0]![0]
    closeCb()

    expect(mockSession.dispose).toHaveBeenCalledTimes(1)
    await connectExpectRefused(port)

    // l'entrée est purgée : l'appel suivant ouvre une NOUVELLE session
    await ensureTunnel("cluster-1", 2375)
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it("nettoyage quand la session SSH rencontre une erreur (error)", async () => {
    const port = await ensureTunnel("cluster-1", 2375)

    const errCb = vi.mocked(mockSession.onError).mock.calls[0]![0]
    errCb(new Error("réseau coupé"))

    expect(mockSession.dispose).toHaveBeenCalledTimes(1)
    await connectExpectRefused(port)
  })

it("nettoyage un seul appel même si close et error se suivent", async () => {
    await ensureTunnel("cluster-1", 2375)

    const closeCb = vi.mocked(mockSession.onClose).mock.calls[0]![0]
    const errCb = vi.mocked(mockSession.onError).mock.calls[0]![0]
    errCb(new Error("boom"))
    closeCb()

    expect(mockSession.dispose).toHaveBeenCalledTimes(1)
  })

  it("session morte avant l'écoute → rejet, aucune entrée fantôme", async () => {
    const promise = ensureTunnel("cluster-1", 2375)

    // laisse connect + listeners se poser (microtasks) AVANT le callback de listen
    for (let i = 0; i < 10 && mockSession.onError.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(mockSession.onError).toHaveBeenCalled()

    const errCb = vi.mocked(mockSession.onError).mock.calls[0]![0]
    errCb(new Error("connexion coupée"))

    await expect(promise).rejects.toThrow(/coupée|fermée/)
    expect(mockSession.dispose).toHaveBeenCalledTimes(1)

    // pas d'entrée fantôme : l'appel suivant ouvre une NOUVELLE session
    await ensureTunnel("cluster-1", 2375)
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it("closeTunnel ferme serveur et session, sans erreur en double-appel", async () => {
    const port = await ensureTunnel("cluster-1", 2375)

    closeTunnel("cluster-1", 2375)
    expect(mockSession.dispose).toHaveBeenCalled()
    await connectExpectRefused(port)

    // entrée purgée : l'appel suivant ouvre une NOUVELLE session
    await ensureTunnel("cluster-1", 2375)
    expect(mockConnect).toHaveBeenCalledTimes(2)

    // teardown idempotent : un second closeTunnel ne lève rien
    expect(() => closeTunnel("cluster-1", 2375)).not.toThrow()
  })

  it("création échouée → clé purgée, un nouvel appel retente (anti-poison)", async () => {
    vi.mocked(mockConnect).mockRejectedValueOnce(new Error("SSH: connexion refusée"))

    await expect(ensureTunnel("cluster-1", 2375)).rejects.toThrow(/refusée/)

    // pending purgé après l'échec : le prochain appel repart d'une session neuve
    await ensureTunnel("cluster-1", 2375)
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it("closeTunnel pendant la création → fermé une fois monté", async () => {
    let release!: (s: unknown) => void
    const gated = new Promise((resolve) => {
      release = resolve
    })
    vi.mocked(mockConnect).mockImplementationOnce(() => gated as never)

    const tunnel = ensureTunnel("cluster-1", 2375)
    closeTunnel("cluster-1", 2375) // création encore en vol

    release(mockSession)
    const port = await tunnel

    // tunnel monté puis fermé immédiatement : port refusé, session disposée
    await connectExpectRefused(port)
    expect(mockSession.dispose).toHaveBeenCalled()
  })
})
