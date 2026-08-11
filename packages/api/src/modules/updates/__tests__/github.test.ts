import { describe, it, expect, vi, afterEach } from "vitest"
import { GitHubReleasesService, compareVersions } from "../github"

type MockFetch = typeof fetch & { mock: { calls: Array<[string, RequestInit]> } }

function mockFetch(releases: unknown[]): MockFetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(releases),
  }) as unknown as MockFetch
}

describe("compareVersions (semver maison)", () => {
  it("compare des versions stables", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0)
    expect(compareVersions("1.3.0", "1.2.99")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0)
    expect(compareVersions("1.2.2", "1.2.3")).toBeLessThan(0)
  })

  it("tolère le préfixe v", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("v1.2.3", "1.2.2")).toBeGreaterThan(0)
  })

  it("une version stable prime sur une pré-release de même numéro", () => {
    expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.2.3-beta.2", "1.2.3-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.2.3-rc.1", "1.2.3-beta.5")).toBeGreaterThan(0)
  })

  it("compare les identifiants numériques des pré-releases numériquement (semver)", () => {
    // beta.10 > beta.2 (lexicographique donnerait l'inverse — bug semver).
    expect(compareVersions("1.2.3-beta.10", "1.2.3-beta.2")).toBeGreaterThan(0)
    expect(compareVersions("1.2.3-beta.2", "1.2.3-beta.10")).toBeLessThan(0)
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0)
    // numérique < alphanumérique (semver : 1.0.0-alpha.1 < 1.0.0-alpha.a).
    expect(compareVersions("1.2.3-alpha.1", "1.2.3-alpha.a")).toBeLessThan(0)
    // plus d'identifiants = plus récent (alpha < alpha.1).
    expect(compareVersions("1.2.3-alpha", "1.2.3-alpha.1")).toBeLessThan(0)
  })

  it("fallback lexicographique pour les tags non semver (ne plante jamais)", () => {
    expect(compareVersions("latest", "1.2.3")).not.toBeNaN()
    expect(compareVersions("bar", "foo")).toBeLessThan(0)
    expect(compareVersions("foo", "bar")).toBeGreaterThan(0)
  })
})

describe("GitHubReleasesService", () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("liste les releases stables triées par version décroissante", async () => {
    process.env.GHCR_OWNER = "fotetsa"
    const service = new GitHubReleasesService(
      mockFetch([
        { tag_name: "v1.2.0", prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z", html_url: "u", body: "notes" },
        { tag_name: "v1.2.2", prerelease: false, draft: false, published_at: "2026-03-01T00:00:00Z", html_url: "u", body: "notes" },
        { tag_name: "v1.3.0-beta.1", prerelease: true, draft: false, published_at: "2026-04-01T00:00:00Z", html_url: "u", body: "notes" },
        { tag_name: "v1.2.1", prerelease: false, draft: false, published_at: "2026-02-01T00:00:00Z", html_url: "u", body: "notes" },
        { tag_name: "v0.9.0", prerelease: false, draft: true, published_at: "2025-01-01T00:00:00Z", html_url: "u", body: "notes" },
      ]),
    )

    const releases = await service.listReleases("stable")

    expect(releases.map((r) => r.version)).toEqual(["1.2.2", "1.2.1", "1.2.0"])
    expect(releases[0]).toMatchObject({
      tag: "v1.2.2",
      version: "1.2.2",
      prerelease: false,
      notes: "notes",
    })
  })

  it("inclut les pré-releases en canal beta", async () => {
    const service = new GitHubReleasesService(
      mockFetch([
        { tag_name: "v1.3.0-beta.1", prerelease: true, draft: false },
        { tag_name: "v1.2.2", prerelease: false, draft: false },
      ]),
    )

    const releases = await service.listReleases("beta")

    expect(releases.map((r) => r.version)).toEqual(["1.3.0-beta.1", "1.2.2"])
  })

  it("envoie le token GitHub en header s'il est configuré", async () => {
    process.env.GITHUB_TOKEN = "ghp_secret"
    const fetchFn = mockFetch([{ tag_name: "v1.0.0", prerelease: false, draft: false }])
    const service = new GitHubReleasesService(fetchFn)

    await service.latest("stable")

    const [, init] = fetchFn.mock.calls[0]!
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secret")
  })

  it("fonctionne sans token (lecture publique)", async () => {
    delete process.env.GITHUB_TOKEN
    const fetchFn = mockFetch([{ tag_name: "v1.0.0", prerelease: false, draft: false }])
    const service = new GitHubReleasesService(fetchFn)

    const latest = await service.latest("stable")

    expect(latest?.version).toBe("1.0.0")
    const [, init] = fetchFn.mock.calls[0]!
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it("propage les erreurs GitHub (403 = rate-limit)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: () => Promise.resolve({}),
    }) as unknown as typeof fetch
    const service = new GitHubReleasesService(fetchFn)

    await expect(service.latest("stable")).rejects.toThrow(/403.*rate-limit/s)
  })

  it("met en cache les résultats (TTL) : pas de 2e fetch sur le même canal", async () => {
    const fetchFn = mockFetch([{ tag_name: "v1.2.3", prerelease: false, draft: false }])
    const service = new GitHubReleasesService(fetchFn)

    await service.listReleases("stable", 20)
    await service.listReleases("stable", 20)
    // Un seul appel réseau pour deux lectures (check() appelle two fois le même canal).
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("ne cache pas les erreurs : re-fetch au 2e appel après 403", async () => {
    let calls = 0
    const fetchFx = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return { ok: false, status: 403, statusText: "Forbidden", json: () => Promise.resolve({}) }
      }
      return { ok: true, status: 200, statusText: "OK", json: () => Promise.resolve([{ tag_name: "v1.0.0", prerelease: false, draft: false }]) }
    }) as unknown as typeof fetch
    const service = new GitHubReleasesService(fetchFx)

    await expect(service.listReleases("stable")).rejects.toThrow()
    const releases = await service.listReleases("stable")
    expect(releases.map((r) => r.version)).toEqual(["1.0.0"])
  })

  it("isUpdateAvailable compare la version courante à la cible", async () => {
    const service = new GitHubReleasesService(mockFetch([]))
    expect(service.isUpdateAvailable("1.2.2", "1.2.3")).toBe(true)
    expect(service.isUpdateAvailable("1.2.3", "1.2.3")).toBe(false)
    expect(service.isUpdateAvailable("1.2.4", "1.2.3")).toBe(false)
    expect(service.isUpdateAvailable("1.2.2", "1.3.0-beta.1")).toBe(true)
  })
})
