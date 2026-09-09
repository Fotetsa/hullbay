import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  resolveLatestPatroniTag,
  __resetPatroniResolveCache,
} from "../../providers/postgres.js"

function ok(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

function makeFetch(tags: string[]): typeof fetch & { tagsListCalls: number } {
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/token")) {
      return ok({ token: "anon-token" })
    }
    if (url.includes("/tags/list")) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer anon-token" })
      fn.tagsListCalls++
      return ok({ tags })
    }
    throw new Error(`fetch inattendu : ${url}`)
  }) as typeof fetch & { tagsListCalls: number }
  fn.tagsListCalls = 0
  return fn
}

beforeEach(() => {
  __resetPatroniResolveCache()
})

describe("resolveLatestPatroniTag — tag Patroni résolu sur le registre", () => {
  it("prend le plus récent (tri semver décroissant) pour la majeure PG ciblée", async () => {
    const fetchImpl = makeFetch([
      "v3.3.0-pg16",
      "v4.1.5-pg16",
      "v4.1.4-pg16",
      "v4.1.5-pg14", // autre majeure : ignorée
      "v4.2.0-pg17",
      "latest-pg16",
    ])
    await expect(resolveLatestPatroniTag("16", fetchImpl)).resolves.toBe("v4.1.5-pg16")
  })

  it("version propre au registre prioritaire sur la pin même si plus récente (fix 404)", async () => {
    const fetchImpl = makeFetch(["v6.0.0-pg16"])
    await expect(resolveLatestPatroniTag("16", fetchImpl)).resolves.toBe("v6.0.0-pg16")
  })

  it("cache par majeure : le registre n'est interrogé qu'UNE fois par TTL", async () => {
    const fetchImpl = makeFetch(["v4.1.5-pg16", "v4.1.5-pg15"])
    await resolveLatestPatroniTag("16", fetchImpl)
    await resolveLatestPatroniTag("16", fetchImpl)
    await resolveLatestPatroniTag("16", fetchImpl)
    expect(fetchImpl.tagsListCalls).toBe(1)
    // Une autre majeure : nouvelle interrogation (cache indexé par majeure).
    await resolveLatestPatroniTag("15", fetchImpl)
    expect(fetchImpl.tagsListCalls).toBe(2)
  })

  it("aucun tag pour la majeure → repli silencieux sur le pin", async () => {
    const fetchImpl = makeFetch(["v4.1.5-pg17", "v4.1.5-pg14"])
    await expect(resolveLatestPatroniTag("18", fetchImpl)).resolves.toBe("v3.3.0-pg18")
  })

  it("registre injoignable (HTTP 500) → repli sur le pin, jamais de throw", async () => {
    const bad = ((input: string) => {
      if (String(input).includes("/token")) {
        return Promise.resolve({ ok: false, status: 502, json: async () => ({}) } as Response)
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
    }) as typeof fetch
    await expect(resolveLatestPatroniTag("16", bad)).resolves.toBe("v3.3.0-pg16")
  })

  it("tags[] absent de la réponse → repli pin (registre toujours renseigne tags)", async () => {
    const fetchImpl = makeFetch(undefined as unknown as string[])
    await expect(resolveLatestPatroniTag("16", fetchImpl)).resolves.toBe("v3.3.0-pg16")
  })
})