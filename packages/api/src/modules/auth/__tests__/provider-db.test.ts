import { describe, it, expect, beforeEach, vi } from "vitest"
import { prisma } from "../../../lib/prisma"
import { PROVIDER_SEEDS, SUPERSEDED_GENERIC_IDS } from "../registry/seeds"
import { allSeeds, syncProviderSeedsToDb } from "../registry/provider-db"

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    authProvider: {
      upsert: vi.fn(async (d: { create: { id: string } }) => ({ id: d.create.id })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [] as never[]),
    },
  },
}))
vi.mock("../../../lib/event-bus", () => ({ eventBus: { emit: vi.fn() } }))

describe("Seeds — premier install = local seul", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("allSeeds ne porte AUCUN provider générique (plus de presets factices)", () => {
    const ids = allSeeds().map((s) => s.id)
    expect(ids).toEqual(["local"])
    expect(PROVIDER_SEEDS.some((s) => s.id.endsWith("-generic"))).toBe(false)
  })

  it("sync n'upserte QUE local (aucun preset oidc/oauth2/saml/ldap réinséré)", async () => {
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const ids = await syncProviderSeedsToDb()
    const upserted = vi.mocked(prisma.authProvider.upsert).mock.calls.map((c) => (c[0] as { create: { id: string } }).create.id)
    expect(upserted).toEqual(["local"])
    expect(ids).toEqual(["local"])
  })
})

describe("Pruning des presets historiques — config utilisateur jamais détruite", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("preset générique à config VIDE → supprimé au boot (ne ré-apparaît plus)", async () => {
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([
      { id: "oidc-generic", config: {} },
      { id: "saml-generic", config: { ca: "" } },
    ] as never)
    await syncProviderSeedsToDb()
    const deletes = vi.mocked(prisma.authProvider.deleteMany).mock.calls
    // Ne retient que la suppression des presets (pas celle des ids legacy).
    const staleIds = deletes.flatMap((d) => {
      const inIds = (d[0] as { where?: { id?: { in: string[] } } }).where?.id?.in ?? []
      return inIds.every((id) => SUPERSEDED_GENERIC_IDS.includes(id)) ? inIds : []
    })
    expect(staleIds).toEqual(["oidc-generic", "saml-generic"])
  })

  it("preset générique PARAMÉTRÉ (config non vide) → conservé", async () => {
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([
      { id: "oidc-generic", config: { issuer: "https://idp.example.org", clientId: "c" } },
    ] as never)
    await syncProviderSeedsToDb()
    const deletes = vi.mocked(prisma.authProvider.deleteMany).mock.calls
    const staleIds = deletes.flatMap((d) => {
      const inIds = (d[0] as { where?: { id?: { in: string[] } } }).where?.id?.in ?? []
      return inIds.every((id) => SUPERSEDED_GENERIC_IDS.includes(id)) ? inIds : []
    })
    expect(staleIds).toHaveLength(0)
  })
})