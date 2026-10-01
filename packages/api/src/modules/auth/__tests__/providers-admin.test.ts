import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod"
import { registerProvidersRoutes } from "../routes/providers.routes"
import { registerPendingRoutes } from "../routes/pending.routes"
import { prisma } from "../../../lib/prisma"
import { providerRegistry } from "../registry/provider-registry"

/**
 * CRUD providers + workflow d'approbation (owner).
 *
 * SÉCURITÉ couverte :
 * - jamais de secret en clair en réponse (champs sensibles masqués par marqueur)
 * - jamais de secret en clair EN BASE (chiffré individuellement)
 * - zod par kind : toute clé inconnue dans la config rejetée (anti-injection)
 * - anti-énumération : id inconnu → 404 uniforme
 * - approve : pas d'auto-provision (un pending doit être approuvé par un owner)
 */

vi.mock("../../../lib/prisma", () => {
  const authProvider = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  }
  const tenant = { findUnique: vi.fn() }
  const authIdentity = { count: vi.fn(), create: vi.fn() }
  const pendingIdentity = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() }
  const user = { findUnique: vi.fn(), create: vi.fn() }
  const membership = { upsert: vi.fn() }
  const auditLog = { create: vi.fn(() => Promise.resolve({ id: "audit-1" })) }
  // Transaction par défaut : délègue au MÊME client mocké (count/update/delete
  // redirigés vers les mêmes vi.fn). Les tests du workflow d'approbation la
  // remplacent par leur propre tx (voir txMock) — non affectés. $executeRaw
  // simule le advisory lock de portée (voir tests concurrence, où il est
  // remplacé par un VRAI mutex pour prouver la sérialisation).
  const client = {
    authProvider,
    tenant,
    authIdentity,
    pendingIdentity,
    user,
    membership,
    auditLog,
    $executeRaw: vi.fn(),
  }
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(client)),
    },
  }
})

const emitMock = vi.fn(async (...args: unknown[]) => undefined)
vi.mock("../../../lib/event-bus", () => ({
  eventBus: {
    on: () => () => {},
    emit: (...args: unknown[]) => emitMock(...args),
  },
}))

const { mockSettingsService } = vi.hoisted(() => ({
  mockSettingsService: { get: vi.fn() },
}))
vi.mock("../../settings/service", () => ({ settingsService: mockSettingsService }))

const PENDING_ALICE = {
  id: "pending-1",
  providerId: "oidc-test",
  issuer: "https://idp.example.org",
  subject: "sub-1",
  email: "alice@hullbay.local",
  name: "Alice",
  requestedForTenantId: null,
  status: "pending",
}

async function buildApp(role: "owner" | "operator" = "owner", reqTenant: string = "t-1"): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.addHook("preHandler", async (req) => {
    const r = req as FastifyRequest & { user?: unknown; tenantId?: string }
    r.user = { sub: "u-admin", role, mfaEnabled: true }
    // Tenant effectif posé par la garde en prod (claim/header). En harnais,
    // on simule l'acteur owner appartenant au tenant demandé.
    r.tenantId = reqTenant
  })
  await registerProvidersRoutes(app)
  await registerPendingRoutes(app)
  await app.ready()
  return app
}

function txMock() {
  return {
    user: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (d: { data: Record<string, unknown> }) => ({
        id: "u-new",
        email: d.data.email ?? null,
        name: d.data.name ?? null,
        role: d.data.role,
      })),
    },
    authIdentity: { create: vi.fn(async () => ({ id: "i-new" })) },
    membership: {
      upsert: vi.fn(async (d: { update: { role: string } }) => ({ id: "m-new", role: d.update.role })),
    },
    pendingIdentity: { update: vi.fn() },
  }
}

beforeAll(() => {
  process.env.JWT_SECRET = "providers-test-secret"
})

beforeEach(() => {
  vi.clearAllMocks()
  providerRegistry.clear()
})

describe("Providers admin (owner) — CRUD", () => {
  it("GET — champs sensibles masqués, jamais en clair dans la réponse", async () => {
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([
      { id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, config: { issuer: "https://idp.example.org", clientSecret: "k1234:iv:tag:data" } },
    ] as never)
    const app = await buildApp()
    const res = await app.inject({ method: "GET", url: "/api/auth/admin/providers" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0].config.clientSecret).toBe("••••••••")
    expect(JSON.stringify(body)).not.toContain("k1234")
    await app.close()
  })

  it("GET — non-owner → 403", async () => {
    const app = await buildApp("operator")
    const res = await app.inject({ method: "GET", url: "/api/auth/admin/providers" })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it("POST valide — config chiffrée en base, secret jamais en clair dans AuthProvider", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({ id: "oidc-new", kind: "oidc", name: "New", enabled: true, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    // Re-écriture des champs autogérés (redirect/discovery dérivés) post-création.
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-new", kind: "oidc", name: "New", enabled: true, config: {} } as never)
    // POST n'est possible que depuis le tenant défaut (provider global).
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc",
        name: "New",
        enabled: true,
        config: { issuer: "https://idp.example.org", clientId: "client-1", clientSecret: "super-secret", redirectUri: "https://sp.example.org/cb" },
      },
    })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(prisma.authProvider.create).mock.calls[0]?.[0] as { data: { config: Record<string, unknown>; tenantId: string | null } }
    const stored = call.data.config as Record<string, unknown>
    expect(stored.clientSecret).not.toBe("super-secret")
    expect(String(stored.clientSecret)).toContain(":")
    expect(JSON.stringify(stored)).not.toContain("super-secret")
    // Création depuis le tenant défaut → provider GLOBAL (tenantId null).
    expect(call.data.tenantId).toBeNull()
    await app.close()
  })

  it("POST — config avec clé inconnue rejetée (whitelist zod, anti-injection)", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc",
        name: "Hack",
        config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb", extraFieldScript: "rm -rf /" },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST oauth2 — clientSecret OBLIGATOIRE à la création (bug provider sans secret)", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oauth2",
        name: "OAuth2 sans secret",
        enabled: true,
        config: {
          authorizationUri: "https://idp.example.org/authorize",
          tokenUri: "https://idp.example.org/token",
          userinfoUri: "https://idp.example.org/userinfo",
          clientId: "client-1",
          redirectUri: "https://sp.example.org/cb",
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("invalid_config")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST oauth2 — avec clientSecret → 201, secret chiffré en base (jamais en clair)", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({ id: "oauth2-new", kind: "oauth2", name: "New", enabled: true, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oauth2",
        name: "New",
        enabled: true,
        config: {
          authorizationUri: "https://idp.example.org/authorize",
          tokenUri: "https://idp.example.org/token",
          userinfoUri: "https://idp.example.org/userinfo",
          clientId: "client-1",
          clientSecret: "super-secret-oauth2",
          redirectUri: "https://sp.example.org/cb",
        },
      },
    })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(prisma.authProvider.create).mock.calls[0]?.[0] as { data: { config: Record<string, unknown> } }
    const stored = call.data.config as Record<string, unknown>
    expect(stored.clientSecret).not.toBe("super-secret-oauth2")
    expect(String(stored.clientSecret)).toContain(":")
    expect(JSON.stringify(stored)).not.toContain("super-secret-oauth2")
    await app.close()
  })

  it("POST — kind non géré (ldap) → 400", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "ldap", name: "LDAP", config: {} },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("PUT — marqueur secret conserve la valeur chiffrée existante", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientSecret: "k9988:iv:tag:data" },
    } as never)
    vi.mocked(prisma.authProvider.update).mockImplementation((async () => ({ id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, config: {} })) as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      // Pas d'enabled : mutation de config seule — le garde-fou d'activation ne
      // s'applique pas (état final inchangé = désactivé).
      payload: { config: { issuer: "https://idp.example.org", clientId: "client-1", redirectUri: "https://sp.example.org/cb", clientSecret: "••••••••" } },
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.authProvider.update).mock.calls[0]?.[0] as { data: { config: Record<string, unknown> } }
    expect(call.data.config.clientSecret).toBe("k9988:iv:tag:data")
    await app.close()
  })

  it("PUT — id inconnu → 404 (anti-énumération)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue(null as never)
    const app = await buildApp()
    const res = await app.inject({ method: "PUT", url: "/api/auth/admin/providers/nope", payload: { name: "X" } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it("PUT — activation refusée si config stockée incomplète (garde-fou §5)", async () => {
    // §5 : activer sans config valide = provider mort en prod. La config
    // effective (stockée déchiffrée + delta) doit passer le schéma du kind.
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientSecret: "k9988:iv:tag:data" },
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(400)
    // Blob secret illisible (clé changée) → fail-closed, jamais 500.
    expect(res.json().code).toBe("invalid_config")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — toggle enabled avec config EFFECTIVE valide → 200 sans toucher la config", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "client-1", redirectUri: "https://sp.example.org/cb" },
    } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: true, config: {},
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.authProvider.update).mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(call.data.enabled).toBe(true)
    expect(call.data.config).toBeUndefined()
    await app.close()
  })

  it("DELETE — provider local impossible", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "local", kind: "local", tenantId: "t-1" } as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/local" })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("DELETE — provider utilisé par des identités → 409", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "oidc-corp", kind: "oidc", tenantId: "t-1" } as never)
    vi.mocked(prisma.authIdentity.count).mockResolvedValue(3 as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/oidc-corp" })
    expect(res.statusCode).toBe(409)
    expect(prisma.authProvider.delete).not.toHaveBeenCalled()
    await app.close()
  })

  it("DELETE — id inconnu → 404", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue(null as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/nope" })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it("POST /test — config incomplète → ok:false sans détail exposé", async () => {
vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientSecret: "k9988:iv:tag:data" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({ method: "POST", url: "/api/auth/admin/providers/oidc-corp/test" })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(false)
    await app.close()
  })

  it("GET — liste restreinte au tenant effectif : tenant courant + globaux", async () => {
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    await app.inject({ method: "GET", url: "/api/auth/admin/providers" })
    const call = vi.mocked(prisma.authProvider.findMany).mock.calls[0]?.[0] as { where: Record<string, unknown> }
    // Le filtrage est porté par le where transmis à la DB : jamais de fuite d'un
    // provider d'un autre tenant dans la réponse (l'isolation tient en base).
    expect(call.where).toEqual({ OR: [{ tenantId: "t-1" }, { tenantId: null }] })
    await app.close()
  })

  it("PUT — provider d'un AUTRE tenant → 404 (anti-fuite cross-tenant)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-other", kind: "oidc", name: "Other", enabled: true, tenantId: "tenant-other",
      config: { issuer: "https://idp.example.org", clientId: "c" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-other",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(404)
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — provider GLOBAL → mutable uniquement depuis le tenant défaut (t-1 → 404)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null,
      config: { issuer: "https://idp.example.org", clientId: "c" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-global",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(404)
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("DELETE — provider GLOBAL → mutable uniquement depuis le tenant défaut (t-1 → 404)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null,
    } as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/oidc-global" })
    expect(res.statusCode).toBe(404)
    expect(prisma.authProvider.delete).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST /test — provider GLOBAL invisible depuis un tenant non-défaut (t-1 → 404)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null,
      config: { issuer: "https://idp.example.org", clientId: "c" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({ method: "POST", url: "/api/auth/admin/providers/oidc-global/test" })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it("POST — tenant non-défaut (t-1) → 400 tenant_providers_not_supported, RIEN persisté", async () => {
    // Le registre SSO partagé ne résout que les providers globaux ou du tenant
    // défaut : créer pour un autre tenant produirait un provider fantôme (201
    // en base, 404 à chaque login). Refus explicite → jamais de row orpheline.
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "oidc", name: "T1", enabled: true, config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_providers_not_supported")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    // Rejet avant le garde-fou domaine : aucune lecture de Settings.
    expect(mockSettingsService.get).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST — tenantId='tenant-other' dans le body → 400 tenant_id_not_allowed, rien persisté", async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc", name: "Squatteur", enabled: false,
        tenantId: "tenant-other",
        config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST — tenantId=null dans le body → 400 tenant_id_not_allowed (création globale interdite)", async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc", name: "Global malgré moi", enabled: false, tenantId: null,
        config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — tenantId='tenant-other' dans le body → 400 tenant_id_not_allowed, update non appelé", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { tenantId: "tenant-other" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — tenantId=null dans le body → 400 tenant_id_not_allowed (re-scope global interdit)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { tenantId: null },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — tenantId='t-1' (même tenant) dans le body → 400 : le tenant n'est PAS modifiable", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { tenantId: "t-1" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — désactivation du dernier provider DU TENANT refusée : un provider actif d'un AUTRE tenant ne compte pas", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    // Aucun autre provider actif du tenant t-1 (le provider B EST actif, mais
    // il appartient au tenant tenant-other).
    vi.mocked(prisma.authProvider.count).mockResolvedValue(0 as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-a",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("cannot_disable_last_provider")
    // Le count est bien scopé au tenant du provider — jamais global.
    expect(prisma.authProvider.count).toHaveBeenCalledWith({
      where: { id: { not: "oidc-a" }, enabled: true, tenantId: "t-1" },
    })
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    // Garde plaquée en transaction avec la mutation (anti-TOCTOU) : le refus
    // est levé DANS $transaction, pas par un count hors-ligne.
    expect(prisma.$transaction).toHaveBeenCalled()
    await app.close()
  })

  it("PUT — désactivation possible si un autre provider DU MÊME TENANT reste actif", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(1 as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: false, tenantId: "t-1", config: {},
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-a",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(prisma.authProvider.count).toHaveBeenCalledWith({
      where: { id: { not: "oidc-a" }, enabled: true, tenantId: "t-1" },
    })
    await app.close()
  })

  it("PUT — désactivation du dernier provider du tenant refusée MÊME SI un provider GLOBAL est actif", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1",
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    // Le count est tenant-scoped : le provider global B actif (tenantId null)
    // est exclu → count 0 → refus.
    vi.mocked(prisma.authProvider.count).mockResolvedValue(0 as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-a",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("cannot_disable_last_provider")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("DELETE — dernier provider du tenant → 400 cannot_delete_last_provider (count scopé tenant)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1",
    } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(0 as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/oidc-a" })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("cannot_delete_last_provider")
    expect(prisma.authProvider.count).toHaveBeenCalledWith({
      where: { id: { not: "oidc-a" }, enabled: true, tenantId: "t-1" },
    })
    expect(prisma.authProvider.delete).not.toHaveBeenCalled()
    await app.close()
  })

  it("DELETE — autorisé si un autre provider du MÊME tenant est actif", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1",
    } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(1 as never)
    vi.mocked(prisma.authIdentity.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.pendingIdentity.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.authProvider.delete).mockResolvedValue({} as never)
    const app = await buildApp()
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/oidc-a" })
    expect(res.statusCode).toBe(204)
    expect(prisma.authProvider.delete).toHaveBeenCalledWith({ where: { id: "oidc-a" } })
    // Garde + comptes + delete atomiques (anti-TOCTOU).
    expect(prisma.$transaction).toHaveBeenCalled()
    await app.close()
  })

  it("PUT — règle GLOBALE : désactivation du dernier provider global (tenant défaut) refusée", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null,
      config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
    } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(0 as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-global",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("cannot_disable_last_provider")
    // Règle globale : count parmi les globaux uniquement.
    expect(prisma.authProvider.count).toHaveBeenCalledWith({
      where: { id: { not: "oidc-global" }, enabled: true, tenantId: null },
    })
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("DELETE — règle GLOBALE : dernier provider global refusé", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null,
    } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(0 as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({ method: "DELETE", url: "/api/auth/admin/providers/oidc-global" })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("cannot_delete_last_provider")
    expect(prisma.authProvider.delete).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — CONCURRENCE RÉELLE (mutex par clé) : 2 désactivations simultanées de la portée → 1 succès, 1 refus", async () => {
    const config = { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" }
    // DB simulée STATEFUL : A et B actifs dans le tenant t-1. Le premier
    // commit (A désactivé) conditionne la ré-lecture du second — son count ne
    // voit plus que 0 → refus. C'est le faux advisory lock (mutex par clé)
    // qui impose cet ordre, comme pg_advisory_xact_lock en base réelle : sans
    // lui, les deux transactions liraient le count avant tout commit et les
    // deux désactivations passeraient → portée à zéro provider actif.
    const db = new Map<
      string,
      { id: string; kind: string; name: string; enabled: boolean; tenantId: string | null; config: unknown }
    >([
      ["oidc-a", { id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1", config }],
      ["oidc-b", { id: "oidc-b", kind: "oidc", name: "B", enabled: true, tenantId: "t-1", config }],
    ])
    const row = (id: string) => {
      const r = db.get(id)
      return r ? { ...r } : undefined
    }
    vi.mocked(prisma.authProvider.findUnique).mockImplementation(((async (args: { where: { id: string } }) => row(args.where.id)) as never))
    vi.mocked(prisma.authProvider.count).mockImplementation((async (args: {
      where?: { id?: { not?: string }; tenantId?: string | null }
    }) => {
      const not = args?.where?.id?.not ?? ""
      const tenantId = args?.where?.tenantId ?? null
      let n = 0
      for (const r of db.values()) {
        if (r.id !== not && r.enabled && r.tenantId === tenantId) n += 1
      }
      return n
    }) as never)
    vi.mocked(prisma.authProvider.update).mockImplementation((async (args: { where: { id: string }; data: { enabled?: boolean } }) => {
      const current = db.get(args.where.id)!
      const next = { ...current, enabled: args.data.enabled ?? current.enabled }
      db.set(current.id, next)
      return { ...next }
    }) as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)

    // VRAI mutex simulé du advisory lock : un verrou par clé, tenu jusqu'au
    // premier write (update/delete) de la transaction qui l'a acquis.
    const held = new Set<string>()
    let signal: { p: Promise<void>; resolve: () => void }
    const newSignal = () => {
      let resolveFn!: () => void
      const p = new Promise<void>((r) => (resolveFn = r))
      const s = { p, resolve: resolveFn }
      signal = s
      return s
    }
    newSignal()
    const release = () => {
      held.clear()
      signal.resolve()
      newSignal()
    }
    vi.mocked(prisma.$executeRaw).mockImplementation((async (_q: TemplateStringsArray, key?: unknown) => {
      const k = String(key ?? "g:global")
      while (held.has(k)) await signal.p
      held.add(k)
      return 1
    }) as never)

    const app = await buildApp()
    const disable = (id: string) => app.inject({ method: "PUT", url: `/api/auth/admin/providers/${id}`, payload: { enabled: false } })
    // Relâche le mutex une fois le premier flux terminé (commit simulé).
    const rA = disable("oidc-a").then((r) => {
      release()
      return r
    })
    const rB = disable("oidc-b")
    const [ra, rb] = await Promise.all([rA, rB])
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 400])
    const refused = ra.statusCode === 400 ? ra : rb
    expect(refused.json().code).toBe("cannot_disable_last_provider")
    // Sérialisation : exactement UNE mutation a abouti.
    expect(prisma.authProvider.update).toHaveBeenCalledTimes(1)
    // Lock acquis aux deux passes (mutex par clé t:<tenant>).
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2)
    const raw = JSON.stringify(vi.mocked(prisma.$executeRaw).mock.calls)
    expect(raw).toContain("hullbay:providers:")
    expect(raw).toContain("t:t-1")
    // Hygiène : le flux refusé a acquis le verrou sans jamais l'écrire —
    // relâcher pour ne pas pendre les tests suivants (mock persistant).
    release()
    await app.close()
  })

  it("DELETE — CONCURRENCE RÉELLE (mutex par clé) : 2 suppressions simultanées scoped → 1 succès, 1 refus", async () => {
    const db = new Map<string, { id: string; kind: string; name: string; enabled: boolean; tenantId: string | null }>([
      ["oidc-a", { id: "oidc-a", kind: "oidc", name: "A", enabled: true, tenantId: "t-1" }],
      ["oidc-b", { id: "oidc-b", kind: "oidc", name: "B", enabled: true, tenantId: "t-1" }],
    ])
    const row = (id: string) => {
      const r = db.get(id)
      return r ? { ...r } : undefined
    }
    vi.mocked(prisma.authProvider.findUnique).mockImplementation(((async (args: { where: { id: string } }) => row(args.where.id)) as never))
    vi.mocked(prisma.authProvider.count).mockImplementation((async (args: {
      where?: { id?: { not?: string }; tenantId?: string | null }
    }) => {
      const not = args?.where?.id?.not ?? ""
      const tenantId = args?.where?.tenantId ?? null
      let n = 0
      for (const r of db.values()) {
        if (r.id !== not && r.enabled && r.tenantId === tenantId) n += 1
      }
      return n
    }) as never)
    vi.mocked(prisma.authIdentity.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.pendingIdentity.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.authProvider.delete).mockImplementation((async (args: { where: { id: string } }) => {
      const r = db.get(args.where.id)
      if (r) db.delete(r.id)
      return r ?? {}
    }) as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)

    const held = new Set<string>()
    let signal: { p: Promise<void>; resolve: () => void }
    const newSignal = () => {
      let resolveFn!: () => void
      const p = new Promise<void>((r) => (resolveFn = r))
      const s = { p, resolve: resolveFn }
      signal = s
      return s
    }
    newSignal()
    const release = () => {
      held.clear()
      signal.resolve()
      newSignal()
    }
    vi.mocked(prisma.$executeRaw).mockImplementation((async (_q: TemplateStringsArray, key?: unknown) => {
      const k = String(key ?? "g:global")
      while (held.has(k)) await signal.p
      held.add(k)
      return 1
    }) as never)

    const app = await buildApp()
    const remove = (id: string) => app.inject({ method: "DELETE", url: `/api/auth/admin/providers/${id}` })
    const rA = remove("oidc-a").then((r) => {
      release()
      return r
    })
    const rB = remove("oidc-b")
    const [ra, rb] = await Promise.all([rA, rB])
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([204, 400])
    const refused = ra.statusCode === 400 ? ra : rb
    expect(refused.json().code).toBe("cannot_delete_last_provider")
    expect(prisma.authProvider.delete).toHaveBeenCalledTimes(1)
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2)
    const raw = JSON.stringify(vi.mocked(prisma.$executeRaw).mock.calls)
    expect(raw).toContain("hullbay:providers:")
    expect(raw).toContain("t:t-1")
    release()
    await app.close()
  })
})

describe("Garde-fou §9 — domaine public requis (production)", () => {
  const prod = () => {
    process.env.NODE_ENV = "production"
  }
  const prevNodeEnv = process.env.NODE_ENV
  const OIDC_CONFIG = { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" }
  // Provider PROVISIONNÉ (config effective valide) — activable par le garde-fou §5.
  const OIDC_ROW = { id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1", config: OIDC_CONFIG }

  afterAll(() => {
    process.env.NODE_ENV = prevNodeEnv
  })

  beforeEach(() => {
    vi.clearAllMocks()
    prod()
  })

  it("POST oidc actif sans domaine → 400 domain_not_configured, RIEN persisté", async () => {
    mockSettingsService.get.mockResolvedValue({ domain: null })
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "oidc", name: "NoDomain", enabled: true, config: OIDC_CONFIG },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("domain_not_configured")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST oidc désactivé sans domaine → 201 (état inerte autorisé)", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({ id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: null, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "oidc", name: "NoDomain", enabled: false, config: OIDC_CONFIG },
    })
    expect(res.statusCode).toBe(201)
    // Lecture settings : résolution de la base publique pour les champs
    // autogérés — portée = provider créé (GLOBAL), donc tenant défaut.
    expect(mockSettingsService.get).toHaveBeenCalledWith("tenant-default")
    await app.close()
  })

  it("PUT oidc actif — provider GLOBAL (tenant défaut) → domaine de DEFAULT_TENANT_ID requis", async () => {
    mockSettingsService.get.mockResolvedValue({ domain: "hullbay.local" })
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "oidc-global", kind: "oidc", name: "Global", enabled: false, tenantId: null, config: OIDC_CONFIG,
    } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-global", kind: "oidc", name: "Global", enabled: true, tenantId: null, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-global",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    // §9.3 : portée réelle = tenantId null → settings du tenant défaut.
    expect(mockSettingsService.get).toHaveBeenCalledWith("tenant-default")
    await app.close()
  })

  it("POST oidc actif — domaine du tenant DÉFAUT suffit pour un provider GLOBAL créé", async () => {
    mockSettingsService.get.mockResolvedValue({ domain: "hullbay.local" })
    vi.mocked(prisma.authProvider.create).mockResolvedValue({ id: "oidc-new", kind: "oidc", name: "New", enabled: true, tenantId: null, config: {} } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-new", kind: "oidc", name: "New", enabled: true, tenantId: null, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "oidc", name: "New", enabled: true, config: OIDC_CONFIG },
    })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(prisma.authProvider.create).mock.calls[0]?.[0] as { data: { tenantId: string | null } }
    // La portée réelle d'un provider créé via l'API est toujours GLOBALE.
    expect(call.data.tenantId).toBeNull()
    expect(mockSettingsService.get).toHaveBeenCalledWith("tenant-default")
    // Le settings d'un autre tenant (même configuré) n'est jamais consulté.
    expect(mockSettingsService.get).not.toHaveBeenCalledWith("t-1")
    await app.close()
  })

  it("POST ldap actif sans domaine → 201 (protocol non dépendant du domaine)", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({ id: "ldap-corp", kind: "ldap", name: "LDAP", enabled: true, tenantId: null, config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "ldap", name: "LDAP", enabled: true, config: { url: "ldap://dc.example.org", searchBase: "dc=example,dc=org", searchFilter: "(uid={{username}})", stableAttr: "uid" } },
    })
    expect(res.statusCode).toBe(201)
    expect(mockSettingsService.get).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — toggle enabled:true sur oidc sans domaine → 400, update NON appelé", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW } as never)
    mockSettingsService.get.mockResolvedValue({ domain: null })
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("domain_not_configured")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — toggle enabled:true avec domaine configuré → 200", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW } as never)
    mockSettingsService.get.mockResolvedValue({ domain: "hullbay.local" })
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-corp", kind: "oidc", name: "Corp", enabled: true, tenantId: "t-1", config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect(prisma.authProvider.update).toHaveBeenCalled()
    await app.close()
  })

  it("PUT partiel sans enabled — état final = row.enabled (false) → garde ignorée", async () => {
    // §9.2 : on évalue l'état FINAL (row.enabled si body.enabled absent), jamais
    // seulement le body. Ici le provider est inerte : la mutation de config est permise.
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ ...OIDC_ROW } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { name: "Rename only" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSettingsService.get).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — activation du provider A (tenant t-1) : les Settings d'un AUTRE tenant (B, pourtant configurés) ne sont JAMAIS consultés", async () => {
    // Settings de B existent avec un domaine valide — jamais utilisés pour A.
    mockSettingsService.get.mockImplementation(async (tenantId: string) =>
      tenantId === "t-1" ? { domain: "a.example.com" } : { domain: "b.example.com" },
    )
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-corp", kind: "oidc", name: "Corp", enabled: true, tenantId: "t-1", config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    // Portée effective = provider (row.tenantId) — une et une seule résolution,
    // pour t-1 uniquement : le settings d'un autre tenant (B) est invisible.
    expect(mockSettingsService.get).toHaveBeenCalledTimes(1)
    expect(mockSettingsService.get).toHaveBeenCalledWith("t-1")
    await app.close()
  })

  it("PUT — tenantId présent dans le body → 400 tenant_id_not_allowed AVANT toute lecture Settings", async () => {
    mockSettingsService.get.mockResolvedValue({ domain: "hullbay.local" })
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW, enabled: true } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { tenantId: null },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("tenant_id_not_allowed")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    // Le re-scope est bloqué avant la garde domaine / autoManaged : aucune
    // résolution de Settings de quelque tenant que ce soit.
    expect(mockSettingsService.get).not.toHaveBeenCalled()
    await app.close()
  })

  it("PUT — désactivation autorisée sans domaine", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ ...OIDC_ROW, enabled: true } as never)
    vi.mocked(prisma.authProvider.count).mockResolvedValue(1 as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({ id: "oidc-corp", kind: "oidc", name: "Corp", enabled: false, tenantId: "t-1", config: {} } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "PUT",
      url: "/api/auth/admin/providers/oidc-corp",
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe("Workflow d'approbation (owner)", () => {
  it("GET — liste les identités en attente", async () => {
    vi.mocked(prisma.pendingIdentity.findMany).mockResolvedValue([PENDING_ALICE] as never)
    const app = await buildApp()
    const res = await app.inject({ method: "GET", url: "/api/auth/admin/pendings" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    await app.close()
  })

  it("approve — User + AuthIdentity + Membership en transaction, pending → approved, event émis", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue(PENDING_ALICE as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "t-1", name: "Default" } as never)
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "oidc-test", kind: "oidc" } as never)
    const tx = txMock()
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: unknown) => Promise<unknown>) => fn(tx as never)) as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-1/approve",
      payload: { tenantId: "t-1", role: "operator" },
    })
    expect(res.statusCode).toBe(200)
    expect(tx.user.create).toHaveBeenCalled()
    expect(tx.authIdentity.create).toHaveBeenCalled()
    expect(tx.membership.upsert).toHaveBeenCalledTimes(1)
    expect(tx.pendingIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "approved", requestedForTenantId: "t-1" }),
      }),
    )
    await vi.waitFor(() => expect(emitMock).toHaveBeenCalledWith("auth.pending.approved", expect.any(Object)))
    await app.close()
  })

  it("approve — demande OAuth2 (issuer NULL) approuvable — bug gate issuer", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue({
      id: "pending-oauth2", providerId: "oauth2-test", issuer: null, subject: "a7bc8585",
      email: "alice@hullbay.local", name: "Alice", requestedForTenantId: null, status: "pending",
    } as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "t-1", name: "Default" } as never)
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "oauth2-test", kind: "oauth2" } as never)
    const tx = txMock()
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: unknown) => Promise<unknown>) => fn(tx as never)) as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-oauth2/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(200)
    expect(tx.user.create).toHaveBeenCalled()
    expect(tx.authIdentity.create).toHaveBeenCalled()
    await app.close()
  })

  it("approve — demande absente → 404 (anti-énumération)", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue(null as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/nope/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it("approve — compte existant + email NON vérifié → 409, identité jamais liée", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue({ ...PENDING_ALICE, id: "pending-1", emailVerified: false } as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "t-1", name: "Default" } as never)
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "oidc-test", kind: "oidc" } as never)
    const tx = txMock()
    tx.user.findUnique.mockResolvedValue({ id: "u-existant", email: "alice@hullbay.local", role: "viewer" } as never)
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: unknown) => Promise<unknown>) => fn(tx as never)) as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-1/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("email_not_verified")
    expect(tx.user.create).not.toHaveBeenCalled()
    expect(tx.authIdentity.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("approve — compte existant + email VÉRIFIÉ → réutilise le User, ne le recrée pas", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue({ ...PENDING_ALICE, id: "pending-2", emailVerified: true } as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "t-1", name: "Default" } as never)
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({ id: "oidc-test", kind: "oidc" } as never)
    const tx = txMock()
    tx.user.findUnique.mockResolvedValue({ id: "u-existant", email: "alice@hullbay.local", role: "viewer" } as never)
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: unknown) => Promise<unknown>) => fn(tx as never)) as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-2/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(200)
    expect(tx.user.create).not.toHaveBeenCalled()
    expect(tx.authIdentity.create).toHaveBeenCalled()
    await app.close()
  })

  it("approve — tenant inconnu (tenant de l'acteur) → 400, aucun User créé", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue({ ...PENDING_ALICE, id: "pending-2" } as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-2/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("approve — tenant AUTRE que celui de l'acteur → 403 (escalade cross-tenant, A5)", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue({ ...PENDING_ALICE, id: "pending-3" } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-3/approve",
      payload: { tenantId: "tenant-autre", role: "owner" },
    })
    // Bloqué AVANT toute lecture pending (pas d'oracle d'existence).
    expect(res.statusCode).toBe(403)
    expect(prisma.pendingIdentity.findFirst).not.toHaveBeenCalled()
    await app.close()
  })

  it("approve — non-owner → 403 (pas d'auto-approbation)", async () => {
    const app = await buildApp("operator")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-1/approve",
      payload: { tenantId: "t-1", role: "viewer" },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it("reject — marque rejected + event émis, aucune provision", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue(PENDING_ALICE as never)
    vi.mocked(prisma.pendingIdentity.update).mockResolvedValue({ ...PENDING_ALICE, status: "rejected" } as never)
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/pendings/pending-1/reject",
      payload: { reason: "compte non désiré" },
    })
    expect(res.statusCode).toBe(200)
    expect(prisma.pendingIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }),
    )
    await vi.waitFor(() => expect(emitMock).toHaveBeenCalledWith("auth.pending.rejected", expect.any(Object)))
    await app.close()
  })

  it("reject — demande absente → 404", async () => {
    vi.mocked(prisma.pendingIdentity.findFirst).mockResolvedValue(null as never)
    const app = await buildApp()
    const res = await app.inject({ method: "POST", url: "/api/auth/admin/pendings/nope/reject", payload: {} })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe("Phase A rework — autogestion, sanitisation, activation gardée, prévol", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Les describes précédents peuvent laisser un domaine résolu en mock :
    // en env de test, resolvePublicBase doit retomber sur le fallback dev.
    mockSettingsService.get.mockResolvedValue(undefined)
  })

  it("POST oidc sans redirectUri → champs autogérés (callback + discovery) persistés", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({
      id: "oidc-auto", kind: "oidc", name: "Auto", enabled: false, tenantId: "t-1", config: {},
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: { kind: "oidc", name: "Auto", config: { issuer: "https://idp.example.org", clientId: "c" } },
    })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(prisma.authProvider.update).mock.calls[0]?.[0] as { data: { config: Record<string, unknown> } }
    expect(call.data.config.redirectUri).toBe("http://localhost:4000/api/auth/sso/oidc-auto/callback")
    expect(call.data.config.discoveryUrl).toBe("https://idp.example.org/.well-known/openid-configuration")
    await app.close()
  })

  it("POST oidc avec redirectUri EXPLICITE → override expert respecté (??=)", async () => {
    vi.mocked(prisma.authProvider.create).mockResolvedValue({
      id: "oidc-manual", kind: "oidc", name: "Manual", enabled: false, tenantId: "t-1", config: {},
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc",
        name: "Manual",
        config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.custom.org/cb" },
      },
    })
    expect(res.statusCode).toBe(201)
    const call = vi.mocked(prisma.authProvider.update).mock.calls[0]?.[0] as { data: { config: Record<string, unknown> } }
    expect(call.data.config.redirectUri).toBe("https://sp.custom.org/cb")
    await app.close()
  })

  it("POST — scopes vide ('') rejetée (sanitisation trim+min)", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "oidc",
        name: "Scopes vides",
        config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb", scopes: "" },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("invalid_config")
    expect(prisma.authProvider.create).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST ldap — timeoutMs au-delà du plafond (120000) rejeté", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "ldap",
        name: "LDAP lent",
        config: { url: "ldap://dc.example.org", searchBase: "dc=example,dc=org", searchFilter: "(uid={{username}})", stableAttr: "uid", timeoutMs: 120000 },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("invalid_config")
    await app.close()
  })

  it("POST ldap — clé inconnue dans tlsOptions rejetée (strict nested)", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "ldap",
        name: "LDAP tls",
        config: {
          url: "ldap://dc.example.org",
          searchBase: "dc=example,dc=org",
          searchFilter: "(uid={{username}})",
          stableAttr: "uid",
          tlsOptions: { rejectUnauthorized: true, modeInconnu: 3 },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("POST saml — cert NON-PEM rejeté (garde-fou §5)", async () => {
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "saml",
        name: "SAML cassé",
        config: { idpCert: "not-a-certificate", idpIssuer: "https://idp.example.org", entryPoint: "https://idp.example.org/sso" },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("invalid_config")
    expect(res.json().details.idpCert).toBeDefined()
    await app.close()
  })

  it("POST saml — cert X.509 PEM VALIDE (fixture) accepté", async () => {
    const idpCert = readFileSync(path.join(__dirname, "fixtures", "saml", "keys", "idp-cert.pem"), "utf8")
    vi.mocked(prisma.authProvider.create).mockResolvedValue({
      id: "saml-ok", kind: "saml", name: "SAML", enabled: false, tenantId: "t-1", config: {},
    } as never)
    vi.mocked(prisma.authProvider.update).mockResolvedValue({
      id: "saml-ok", kind: "saml", name: "SAML", enabled: false, tenantId: "t-1", config: {},
    } as never)
    vi.mocked(prisma.authProvider.findMany).mockResolvedValue([] as never)
    const app = await buildApp("owner", "tenant-default")
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/admin/providers",
      payload: {
        kind: "saml",
        name: "SAML",
        config: { idpCert, idpIssuer: "https://idp.example.org", entryPoint: "https://idp.example.org/sso" },
      },
    })
    expect(res.statusCode).toBe(201)
    await app.close()
  })

  it("PUT saml — activer avec cert PEM invalide refusé (gate sur config effective)", async () => {
    vi.mocked(prisma.authProvider.findUnique).mockResolvedValue({
      id: "saml-bad", kind: "saml", name: "SAML", enabled: false, tenantId: "t-1",
      config: { idpIssuer: "https://idp.example.org", idpCert: "corrompu-pas-pem", entryPoint: "https://idp.example.org/sso" },
    } as never)
    const app = await buildApp()
    const res = await app.inject({ method: "PUT", url: "/api/auth/admin/providers/saml-bad", payload: { enabled: true } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe("invalid_config")
    expect(prisma.authProvider.update).not.toHaveBeenCalled()
    await app.close()
  })

  it("POST /preflight — config invalide → ok:false schemaValid:false, aucun probe", async () => {
    vi.stubGlobal("fetch", vi.fn())
    try {
      const app = await buildApp()
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/admin/providers/preflight",
        payload: { kind: "oidc", config: { issuer: "pas-une-url" } },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(false)
      expect(res.json().schemaValid).toBe(false)
      expect(res.json().steps).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
      await app.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("POST /preflight — oidc joignable → step discovery ok:true, ok global true", async () => {
    const okResponse = () => new Response(JSON.stringify({ issuer: "https://idp.example.org" }), { status: 200 })
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()))
    try {
      const app = await buildApp()
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/admin/providers/preflight",
        payload: {
          kind: "oidc",
          config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
        },
      })
      expect(res.json().schemaValid).toBe(true)
      expect(res.json().ok).toBe(true)
      expect(res.json().steps.find((s: { step: string }) => s.step === "discovery")).toMatchObject({ ok: true })
      // Le 2e fetch du discovery (parse JSON) est lui aussi borné : timeout
      // 5 s via AbortSignal + politique redirects explicite (follow), comme la
      // probe. Pas de fetch hors-bornes sur une URL fournie par l'admin.
      expect(fetch).toHaveBeenCalledTimes(2)
      const calls = vi.mocked(fetch).mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[1]![1]).toMatchObject({ signal: expect.any(AbortSignal), redirect: "follow" })
      await app.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("POST /preflight — discovery muet → timeout 5 s EFFECTIF (AbortController, pas d'autre fetch)", async () => {
    // Le discovery ne répond jamais tant que le signal n'est pas aborté :
    // la seule façon de sortir est le timeout de fetchWithTimeout (5 s).
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }) as unknown as typeof fetch,
    )
    const app = await buildApp()
    try {
      vi.useFakeTimers()
      const pending = app.inject({
        method: "POST",
        url: "/api/auth/admin/providers/preflight",
        payload: {
          kind: "oidc",
          config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
        },
      })
      await vi.advanceTimersByTimeAsync(5000)
      const res = await pending
      expect(res.json().ok).toBe(false)
      const step = (res.json().steps as { step: string; ok: boolean; message: string }[]).find((s) => s.step === "discovery")
      expect(step?.ok).toBe(false)
      expect(step?.message).toContain("timeout 5s")
      // La probe a échoué : le 2e fetch (JSON) n'est même pas tenté.
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await app.close()
    }
  })

  it("POST /preflight — discovery injoignable → step ok:false, ok global false (wizard bloque)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })))
    try {
      const app = await buildApp()
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/admin/providers/preflight",
        payload: {
          kind: "oidc",
          config: { issuer: "https://idp.example.org", clientId: "c", redirectUri: "https://sp.example.org/cb" },
        },
      })
      expect(res.json().schemaValid).toBe(true)
      expect(res.json().ok).toBe(false)
      expect(res.json().steps.find((s: { step: string }) => s.step === "discovery")).toMatchObject({ ok: false })
      await app.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("POST /preflight — oauth2 : chaque endpoint sondé indépendamment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })))
    try {
      const app = await buildApp()
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/admin/providers/preflight",
        payload: {
          kind: "oauth2",
          config: {
            authorizationUri: "https://idp.example.org/authorize",
            tokenUri: "https://idp.example.org/token",
            userinfoUri: "https://idp.example.org/userinfo",
            clientId: "c",
            clientSecret: "s",
            redirectUri: "https://sp.example.org/cb",
          },
        },
      })
      expect(res.json().ok).toBe(true)
      const steps = res.json().steps as { step: string }[]
      expect(steps.map((s) => s.step)).toEqual(["authorization_uri", "token_uri"])
      await app.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})