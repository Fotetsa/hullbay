import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"
import { registerLdapRoutes } from "../routes/ldap.routes"
import { registerWebauthnRoutes } from "../routes/webauthn.routes"
import { providerRegistry } from "../registry/provider-registry"
import { sessionManager } from "../core/session-manager"
import { authRateLimiter } from "../rate-limit"
import { AuthError } from "../providers/types"
import { IdentityPendingError } from "../core/identity-mapping"

vi.mock("../registry/provider-registry", () => ({
  providerRegistry: {
    get: vi.fn(),
    require: vi.fn(),
  },
}))

vi.mock("../core/auth-core", () => ({
  userHasMfaFactor: vi.fn().mockResolvedValue(true),
}))

vi.mock("../service", () => ({
  authService: {
    verifyToken: vi.fn(),
  },
}))

vi.mock("../core/session-manager", () => ({
  sessionManager: {
    signPending: vi.fn().mockReturnValue("pending_token_123"),
    signSession: vi.fn().mockReturnValue("session_token_456"),
    verifyPending: vi.fn(),
    verifySession: vi.fn(),
  },
}))

vi.mock("../mfa/webauthn", () => ({
  generateWebauthnRegistrationOptions: vi.fn().mockResolvedValue({ challenge: "reg_ch_123" }),
  verifyWebauthnRegistration: vi.fn().mockResolvedValue({ verified: true, credentialId: "cred_123" }),
  generateWebauthnAuthenticationOptions: vi.fn().mockResolvedValue({ challenge: "auth_ch_456" }),
  verifyWebauthnAuthentication: vi.fn().mockResolvedValue({ verified: true }),
  listUserWebauthnCredentials: vi.fn().mockResolvedValue([{ id: "cred_123", name: "Passkey" }]),
  deleteUserWebauthnCredential: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    membership: {
      findUnique: vi.fn(),
    },
  },
}))

import { buildTestApp } from "../../../__tests__/helpers/build-test-app"

import { prisma } from "../../../lib/prisma"
import { userHasMfaFactor } from "../core/auth-core"
import { authService } from "../service"

describe("LDAP & WebAuthn Routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    authRateLimiter.clear()
    vi.mocked(prisma.membership.findUnique).mockImplementation(async ({ where }: any) => {
      const target = where?.userId_tenantId
      if (!target || !target.userId || !target.tenantId) return null
      if (target.userId === "u-1" && target.tenantId === "t-webauthn") {
        return { userId: "u-1", tenantId: "t-webauthn", role: "operator" } as any
      }
      if (target.userId === "u-owner" && target.tenantId === "tenant-default") {
        return { userId: "u-owner", tenantId: "tenant-default", role: "owner" } as any
      }
      return null
    })
    app = await buildTestApp({
      routes: async (a) => {
        // La garde est déjà enregistrée par buildApp (skipRoutes ne la saute pas).
        await registerLdapRoutes(a)
        await registerWebauthnRoutes(a)
        a.get("/api/secret", async () => ({ ok: true }))
      },
    })
    await app.ready()
  })

  describe("POST /api/auth/ldap/:id/login", () => {
    it("connecte avec succès un utilisateur LDAP et émet une session", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockResolvedValue({
          userId: "u-1",
          role: "operator",
          mfaRequired: false,
        }),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/corp-ldap/login",
        payload: {
          username: "alice",
          password: "password123",
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        mfaRequired: false,
        token: "session_token_456",
      })
      expect(mockProvider.authenticate).toHaveBeenCalledWith({
        kind: "ldap",
        ldapUsername: "alice",
        ldapPassword: "password123",
      })
    })

    it("retourne pendingToken si la MFA locale est exigée pour ce rôle", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockResolvedValue({
          userId: "u-owner",
          role: "owner",
          mfaRequired: true,
        }),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/corp-ldap/login",
        payload: {
          username: "admin_ldap",
          password: "password123",
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        mfaRequired: true,
        pendingToken: "pending_token_123",
      })
    })

    it("signe une session de setup si la politique exige la MFA mais aucun facteur n'est enrôlé", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockResolvedValue({
          userId: "u-owner",
          role: "owner",
          mfaRequired: true,
        }),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)
      vi.mocked(userHasMfaFactor).mockResolvedValueOnce(false)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/corp-ldap/login",
        payload: { username: "admin_ldap", password: "password123" },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ mfaRequired: false, token: "session_token_456" })
      expect(sessionManager.signSession).toHaveBeenCalledWith("u-owner", "owner", false, "corp-ldap", "tenant-default")
    })

    it("bloque les tentatives répétées (rate-limit 429)", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockRejectedValue(
          new AuthError("invalid_credentials", "identifiants invalides", 401),
        ),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)

      let res
      for (let i = 0; i < 7; i++) {
        res = await app.inject({
          method: "POST",
          url: "/api/auth/ldap/corp-ldap/login",
          payload: { username: "brute", password: "wrong" },
        })
      }

      expect(res!.statusCode).toBe(429)
      expect(res!.json().code).toBe("rate_limited")
    })

    it("retourne 404 provider_not_found si le provider est absent ou désactivé", async () => {
      vi.mocked(providerRegistry.get).mockReturnValue(undefined)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/unknown/login",
        payload: { username: "alice", password: "password123" },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe("provider_not_found")
    })

    it("retourne 403 identity_pending_approval si l'utilisateur est inconnu (en attente d'approbation)", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockRejectedValue(
          new IdentityPendingError({
            providerId: "corp-ldap",
            kind: "ldap",
            issuer: null,
            subject: "guid-new",
          }),
        ),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/corp-ldap/login",
        payload: {
          username: "new_employee",
          password: "password123",
        },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("identity_pending_approval")
    })

    it("retourne 401 en cas d'identifiants incorrects", async () => {
      const mockProvider = {
        kind: "ldap",
        enabled: true,
        authenticate: vi.fn().mockRejectedValue(
          new AuthError("invalid_credentials", "identifiants invalides", 401),
        ),
      }
      vi.mocked(providerRegistry.get).mockReturnValue(mockProvider as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/ldap/corp-ldap/login",
        payload: {
          username: "alice",
          password: "wrongpassword",
        },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe("invalid_credentials")
    })
  })

  describe("WebAuthn Auth Routes (/api/auth/mfa/webauthn/auth/*)", () => {
    it("génère des options d'authentification avec un pendingToken valide", async () => {
      vi.mocked(sessionManager.verifyPending).mockReturnValue({
        sub: "u-1",
        tenantId: "t-webauthn",
        aud: "mfa-pending",
      } as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/auth/options",
        payload: {
          pendingToken: "pending_token_123",
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ challenge: "auth_ch_456" })
    })

    it("vérifie la signature WebAuthn et émet la session finale", async () => {
      vi.mocked(sessionManager.verifyPending).mockReturnValue({
        sub: "u-1",
        tenantId: "t-webauthn",
        aud: "mfa-pending",
      } as any)

      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "u-1",
        role: "operator",
      } as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/auth/verify",
        payload: {
          pendingToken: "pending_token_123",
          response: { id: "cred_123" },
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        ok: true,
        token: "session_token_456",
      })
      // la session finale porte le TENANT du token pending (jamais dérivé du userId).
      expect(sessionManager.signSession).toHaveBeenCalledWith("u-1", "operator", true, "local", "t-webauthn")
    })

    it("rejette auth/verify sans token ni pendingToken (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/auth/verify",
        payload: { response: { id: "cred_123" } },
      })

      expect(res.statusCode).toBe(401)
    })
  })

  describe("Garde MFA (session sans facteur)", () => {
    it("bloque une route normale quand la session n'a pas la MFA (403 mfa_not_enabled)", async () => {
      vi.mocked(authService.verifyToken).mockReturnValueOnce({
        sub: "u-1",
        role: "owner",
        mfaEnabled: false,
      } as any)

      const res = await app.inject({
        method: "GET",
        url: "/api/secret",
        headers: { authorization: "Bearer setup_session" },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("mfa_not_enabled")
    })

    it("autorise une route de setup quand la session n'a pas la MFA", async () => {
      vi.mocked(authService.verifyToken).mockReturnValueOnce({
        sub: "u-1",
        role: "owner",
        mfaEnabled: false,
      } as any)

      const res = await app.inject({
        method: "GET",
        url: "/api/auth/mfa/webauthn/credentials",
        headers: { authorization: "Bearer setup_session" },
      })

      expect(res.statusCode).toBe(200)
    })
  })

  describe("WebAuthn Setup Routes (/api/auth/mfa/webauthn/register/*)", () => {
    it("rejette l'enrôlement si non authentifié (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/register/options",
      })

      expect(res.statusCode).toBe(401)
    })

    it("rejette l'étape d'enrôlement si la session n'a pas de claim tenantId (401 session_invalid)", async () => {
      vi.mocked(authService.verifyToken).mockReturnValueOnce({
        sub: "u-1",
        role: "owner",
        mfaEnabled: true,
      } as any)
      vi.mocked(sessionManager.verifySession).mockReturnValueOnce({
        sub: "u-1",
        role: "owner",
        mfaEnabled: true,
      } as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/register/options",
        headers: { authorization: "Bearer legacy_session" },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe("session_invalid")
    })

    it("rejette l'authentification step-up si la session n'a pas de claim tenantId (401 session_invalid)", async () => {
      vi.mocked(sessionManager.verifySession).mockReturnValueOnce({
        sub: "u-1",
        role: "owner",
        mfaEnabled: true,
      } as any)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/auth/verify",
        headers: { authorization: "Bearer legacy_session" },
        payload: { response: { id: "cred_123" } },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe("session_invalid")
      // Aucune tentative de cérémonie sur une session non résolvable.
      expect(sessionManager.signSession).not.toHaveBeenCalled()
    })

    it("step-up : le claim tenantId de la session fait autorité pour la config", async () => {
      vi.mocked(sessionManager.verifySession).mockReturnValueOnce({
        sub: "u-1",
        role: "operator",
        mfaEnabled: true,
        tenantId: "t-webauthn",
      } as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: "u-1",
        role: "operator",
      } as never)

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/webauthn/auth/verify",
        headers: { authorization: "Bearer session_with_claim" },
        payload: { response: { id: "cred_123" } },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(true)
      expect(sessionManager.signSession).toHaveBeenCalledWith("u-1", "operator", true, "local", "t-webauthn")
    })
  })
})
