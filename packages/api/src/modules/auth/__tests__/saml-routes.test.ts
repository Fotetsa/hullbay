import { beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { registerSamlRoutes } from "../routes/saml.routes"
import { registerSsoRoutes } from "../routes/sso.routes"
import { providerRegistry } from "../registry/provider-registry"
import { createSamlProvider } from "../providers/saml/saml-provider"
import { SAML_IDP_CERT } from "./fixtures/saml/helpers"

const CALLBACK_URL = "https://sp.example.org/api/auth/saml/me/acs"
const SP_ISSUER = "https://sp.example.org/saml/me"
const IDP_ISSUER = "https://idp.example.org/realms/test"

vi.setConfig({ testTimeout: 15000, hookTimeout: 15000 })

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    authProvider: { findUnique: vi.fn() },
    securityPolicy: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    membership: { findUnique: vi.fn() },
  },
}))

vi.mock("../../../lib/prisma", () => ({ prisma: {} }))
const emitMock = vi.fn((_event: string, _data?: Record<string, unknown>) => Promise.resolve(undefined))
vi.mock("../../../lib/event-bus", () => ({
  eventBus: { on: () => {}, emit: (...args: [string, Record<string, unknown>?]) => emitMock(...args) },
}))

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerSsoRoutes(app)
  await registerSamlRoutes(app)
  providerRegistry.clear()
  providerRegistry.register(
    createSamlProvider({
      id: "saml-test",
      enabled: true,
      idpCert: SAML_IDP_CERT,
      idpIssuer: IDP_ISSUER,
      spIssuer: SP_ISSUER,
      entryPoint: "https://idp.example.org/realms/test/protocol/saml/clients/sp",
      callbackUrl: CALLBACK_URL,
    }),
  )
  await app.ready()
  return app
}

describe("Saml routes (login / metadata / acs)", () => {
  beforeEach(() => {
    providerRegistry.clear()
    emitMock.mockClear()
  })

  it("GET /api/auth/saml/:id/metadata → XML avec entity ID + ACS", async () => {
    const app = await buildApp()
    const res = await app.inject({ method: "GET", url: "/api/auth/saml/saml-test/metadata" })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("application/xml")
    expect(res.body).toContain("SPSSODescriptor")
    expect(res.body).toContain(CALLBACK_URL)
    await app.close()
  })

  it("GET /api/auth/saml/:id/login → 302 vers entryPoint (AuthnRequest redirect)", async () => {
    const app = await buildApp()
    const res = await app.inject({ method: "GET", url: "/api/auth/saml/saml-test/login" })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    expect(loc).toContain("https://idp.example.org/realms/test/protocol/saml")
    expect(loc).toContain("SAMLRequest=")
    expect(loc).toContain("RelayState=")
    await app.close()
  })

  it("provider inconnu → 404 (login/metadata/acs)", async () => {
    const app = await buildApp()
    const login = await app.inject({ method: "GET", url: "/api/auth/saml/nope/login" })
    expect(login.statusCode).toBe(404)
    const meta = await app.inject({ method: "GET", url: "/api/auth/saml/nope/metadata" })
    expect(meta.statusCode).toBe(404)
    const acs = await app.inject({ method: "POST", url: "/api/auth/saml/nope/acs" })
    expect(acs.statusCode).toBe(404)
    await app.close()
  })

  it("POST acs avec SAMLResponse invalide → 400 + page de redirection vers /login (erreurs jamais exposées)", async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/saml/saml-test/acs",
      payload: "SAMLResponse=not-a-saml-response&RelayState=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers["content-type"]).toContain("text/html")
    expect(res.body).toContain("/login?error=")
    // L'erreur technique (invalid_credentials) est un code opaque, pas un détail.
    expect(res.body).not.toContain("not-a-saml-response")
    await app.close()
  })

  it("POST acs invalide → audit auth.saml.failed émis", async () => {
    const app = await buildApp()
    await app.inject({
      method: "POST",
      url: "/api/auth/saml/saml-test/acs",
      payload: "SAMLResponse=not-a-saml-response&RelayState=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    // La boucle d'event bus est asynchrone (fire-and-forget) — on attend.
    await vi.waitFor(() => {
      expect(emitMock).toHaveBeenCalledWith("auth.saml.failed", { providerId: "saml-test" })
    })
    await app.close()
  })

  it("routes acs → cache no-store et page HTML CSP", async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/saml/saml-test/acs",
      payload: "SAMLResponse=not-a-saml-response&RelayState=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    expect(res.headers["cache-control"]).toContain("no-store")
    expect(res.headers["content-security-policy"]).toContain("script-src 'unsafe-inline'")
    await app.close()
  })
})