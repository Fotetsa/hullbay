import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import {
  generateWebauthnRegistrationOptions,
  verifyWebauthnRegistration,
  generateWebauthnAuthenticationOptions,
  verifyWebauthnAuthentication,
  listUserWebauthnCredentials,
  deleteUserWebauthnCredential,
  webauthnChallengeStore,
  getWebauthnConfig,
} from "../mfa/webauthn"
import { AuthError } from "../providers/types"

// Mock de @simplewebauthn/server
const mockGenerateRegOptions = vi.fn()
const mockVerifyRegResponse = vi.fn()
const mockGenerateAuthOptions = vi.fn()
const mockVerifyAuthResponse = vi.fn()

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (args: any) => mockGenerateRegOptions(args),
  verifyRegistrationResponse: (args: any) => mockVerifyRegResponse(args),
  generateAuthenticationOptions: (args: any) => mockGenerateAuthOptions(args),
  verifyAuthenticationResponse: (args: any) => mockVerifyAuthResponse(args),
}))

// Mock de prisma
vi.mock("../../../lib/prisma", () => {
  const txMock = {
    webauthnCredential: {
      create: vi.fn(),
      delete: vi.fn(),
    },
    authIdentity: {
      update: vi.fn(),
    },
  }
  return {
    prisma: {
      authIdentity: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      webauthnCredential: {
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      $transaction: vi.fn((fn: (tx: any) => Promise<any>) => fn(txMock)),
      _txMock: txMock,
    },
  }
})

// Mock de eventBus
vi.mock("../../../lib/event-bus", () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
  },
}))

// Configuration RP : source de vérité = Settings en base (tenant-scoped).
const mockSettingsService = vi.hoisted(() => ({ getWebauthn: vi.fn() }))
vi.mock("../../settings/service", () => ({ settingsService: mockSettingsService }))

import { prisma } from "../../../lib/prisma"

const TENANT = "tenant-a"

describe("WebAuthn / Passkeys Factor", () => {
  const userId = "u-alice"
  const mockIdentity = {
    id: "id-local-1",
    userId,
    kind: "local",
    email: "alice@example.com",
    mfaEnabled: false,
    mfaSecretEnc: null,
    user: { id: userId, email: "alice@example.com", name: "Alice" },
    webauthnCredentials: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    webauthnChallengeStore.clear()
  })

  describe("Configuration du Relying Party (production, base de données)", () => {
    const prevNodeEnv = process.env.NODE_ENV

    afterAll(() => {
      process.env.NODE_ENV = prevNodeEnv
    })

    beforeEach(() => {
      process.env.NODE_ENV = "production"
    })

    it("lit la configuration depuis Settings du tenant", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: "auth.example.com",
        rpName: "Hullbay",
      })

      const cfg = await getWebauthnConfig({ tenantId: TENANT })

      expect(cfg).toEqual({
        rpName: "Hullbay",
        rpID: "auth.example.com",
        origin: "https://auth.example.com",
        allowedOrigins: ["https://auth.example.com"],
      })
      expect(mockSettingsService.getWebauthn).toHaveBeenCalledWith(TENANT)
    })

    it("dérive le RP ID du hostname de l'origin quand il est absent", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      const cfg = await getWebauthnConfig({ tenantId: TENANT })

      expect(cfg.rpID).toBe("auth.example.com")
    })

    it("ignore les variables d'environnement héritées (plus de source env)", async () => {
      const prevOrigin = process.env.WEBAUTHN_ORIGIN
      process.env.WEBAUTHN_ORIGIN = "https://env.example.com"
      try {
        mockSettingsService.getWebauthn.mockResolvedValueOnce({
          enabled: true,
          origin: "https://db.example.com",
          rpId: null,
          rpName: "Hullbay",
        })

        const cfg = await getWebauthnConfig({ tenantId: TENANT })

        expect(cfg.origin).toBe("https://db.example.com")
      } finally {
        if (prevOrigin) process.env.WEBAUTHN_ORIGIN = prevOrigin
        else delete process.env.WEBAUTHN_ORIGIN
      }
    })

    it("config absente → webauthn_not_configured", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: false,
        origin: null,
        rpId: null,
        rpName: "Hullbay",
      })

      await expect(getWebauthnConfig({ tenantId: TENANT })).rejects.toMatchObject({
        code: "webauthn_not_configured",
      })
    })

    it("WebAuthn désactivé → webauthn_not_configured", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: false,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      await expect(getWebauthnConfig({ tenantId: TENANT })).rejects.toMatchObject({
        code: "webauthn_not_configured",
      })
    })

    it("origin absente → webauthn_not_configured", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: null,
        rpId: null,
        rpName: "Hullbay",
      })

      await expect(getWebauthnConfig({ tenantId: TENANT })).rejects.toMatchObject({
        code: "webauthn_not_configured",
      })
    })

    it("clientOrigin correspondant à l'origin configurée → accepté", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      const cfg = await getWebauthnConfig({ tenantId: TENANT, clientOrigin: "https://auth.example.com" })

      expect(cfg.origin).toBe("https://auth.example.com")
    })

    it("origin http:// héritée → webauthn_not_configured (HTTPS exigé en prod)", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "http://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      await expect(getWebauthnConfig({ tenantId: TENANT })).rejects.toMatchObject({
        code: "webauthn_not_configured",
      })
    })

    it("clientOrigin différent → rejet (403 webauthn_origin_forbidden)", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      await expect(
        getWebauthnConfig({ tenantId: TENANT, clientOrigin: "https://evil.example.com" }),
      ).rejects.toMatchObject({ code: "webauthn_origin_forbidden", status: 403 })
    })

    it("le tenant A ne peut pas utiliser la configuration du tenant B", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://a.example.com",
        rpId: null,
        rpName: "Hullbay",
      })
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://b.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      const cfgA = await getWebauthnConfig({ tenantId: "tenant-a" })
      const cfgB = await getWebauthnConfig({ tenantId: "tenant-b", clientOrigin: "https://b.example.com" })

      expect(cfgA.origin).toBe("https://a.example.com")
      expect(cfgB.origin).toBe("https://b.example.com")
    })
  })

  describe("Configuration du Relying Party (développement / test)", () => {
    const prevNodeEnv = process.env.NODE_ENV

    beforeEach(() => {
      process.env.NODE_ENV = "test"
    })

    afterAll(() => {
      process.env.NODE_ENV = prevNodeEnv
    })

    it("fallback localhost conservé en test — aucune config active en base", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: false,
        origin: null,
        rpId: null,
        rpName: "Hullbay",
      })
      const cfg = await getWebauthnConfig({ tenantId: TENANT, clientOrigin: "http://localhost:3000" })
      expect(cfg.origin).toBe("http://localhost:3000")
      expect(cfg.rpID).toBe("localhost")
      expect(mockSettingsService.getWebauthn).toHaveBeenCalledWith(TENANT)
    })

    it("fallback localhost sans clientOrigin (défaut)", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: false,
        origin: null,
        rpId: null,
        rpName: "Hullbay",
      })
      const cfg = await getWebauthnConfig({ tenantId: TENANT })
      expect(cfg.origin).toBe("http://localhost:5273")
      expect(mockSettingsService.getWebauthn).toHaveBeenCalledWith(TENANT)
    })

    it("config DB active en test → utilisée (jamais le fallback)", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })
      const cfg = await getWebauthnConfig({ tenantId: TENANT })
      expect(cfg.origin).toBe("https://auth.example.com")
      expect(cfg.rpID).toBe("auth.example.com")
    })

    it("config DB active en test + clientOrigin différent → 403 webauthn_origin_forbidden", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })
      await expect(
        getWebauthnConfig({ tenantId: TENANT, clientOrigin: "https://evil.example.com" }),
      ).rejects.toMatchObject({ code: "webauthn_origin_forbidden", status: 403 })
    })

    it("aucune fuite entre tenants en environnement test (config active)", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://a.example.com",
        rpId: null,
        rpName: "Hullbay",
      })
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://b.example.com",
        rpId: null,
        rpName: "Hullbay",
      })

      const cfgA = await getWebauthnConfig({ tenantId: "tenant-a" })
      const cfgB = await getWebauthnConfig({ tenantId: "tenant-b" })
      expect(cfgA.origin).toBe("https://a.example.com")
      expect(cfgB.origin).toBe("https://b.example.com")
    })

    it("cérémonie d'enrôlement en test avec config DB active → config du tenant", async () => {
      mockSettingsService.getWebauthn.mockResolvedValueOnce({
        enabled: true,
        origin: "https://auth.example.com",
        rpId: null,
        rpName: "Hullbay",
      })
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)
      mockGenerateRegOptions.mockResolvedValueOnce({ challenge: "reg-ch" })

      await generateWebauthnRegistrationOptions(userId, TENANT)

      const regOptions = mockGenerateRegOptions.mock.calls[0]?.[0] as {
        rpName: string
        rpID: string
      }
      expect(regOptions.rpID).toBe("auth.example.com")
      expect(regOptions.rpName).toBe("Hullbay")
    })
  })

  describe("Enrôlement (Registration)", () => {
    it("génère les options d'enregistrement et stocke le challenge", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)
      mockGenerateRegOptions.mockResolvedValueOnce({
        challenge: "test-reg-challenge-123",
        rp: { name: "Hullbay", id: "localhost" },
        user: { id: "u-alice", name: "alice@example.com", displayName: "Alice" },
      })

      const options = await generateWebauthnRegistrationOptions(userId, TENANT)

      expect(options.challenge).toBe("test-reg-challenge-123")
      expect(webauthnChallengeStore.getAndConsume(`reg:${userId}`)).toBe("test-reg-challenge-123")
    })

    it("exige la vérification utilisateur (UV) à l'enrôlement", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)
      mockGenerateRegOptions.mockResolvedValueOnce({ challenge: "c" })

      await generateWebauthnRegistrationOptions(userId, TENANT)

      expect(mockGenerateRegOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticatorSelection: expect.objectContaining({ userVerification: "required" }),
        }),
      )
    })

    it("isole le challenge stocké par discriminant de token", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)
      mockGenerateRegOptions.mockResolvedValueOnce({ challenge: "ch-token" })

      await generateWebauthnRegistrationOptions(userId, TENANT, undefined, "tokA")

      expect(webauthnChallengeStore.getAndConsume(`reg:${userId}:tokA`)).toBe("ch-token")
      expect(webauthnChallengeStore.getAndConsume(`reg:${userId}`)).toBeNull()
    })

    it("lève une erreur si l'identité locale n'existe pas", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(null)

      await expect(generateWebauthnRegistrationOptions("unknown", TENANT)).rejects.toThrow(AuthError)
    })

    it("retombe sur une identité externe (LDAP/OIDC/SAML) sans identité locale", async () => {
      vi.mocked(prisma.authIdentity.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...mockIdentity,
          id: "id-ldap-1",
          kind: "ldap",
          webauthnCredentials: [],
        } as any)
      mockGenerateRegOptions.mockResolvedValueOnce({ challenge: "ext-reg-challenge" })

      const options = await generateWebauthnRegistrationOptions(userId, TENANT)

      expect(options.challenge).toBe("ext-reg-challenge")
      expect(prisma.authIdentity.findFirst).toHaveBeenCalledTimes(2)
    })

    it("vérifie l'enregistrement, persiste la clé et active la MFA sur l'identité", async () => {
      webauthnChallengeStore.set(`reg:${userId}`, "test-reg-challenge-123")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)

      mockVerifyRegResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: {
            id: "cred-id-abc",
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ["internal"],
          },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      })

      const tx = (prisma as any)._txMock
      tx.webauthnCredential.create.mockResolvedValueOnce({ id: "wc-1", credentialId: "cred-id-abc" })
      tx.authIdentity.update.mockResolvedValueOnce({ id: "id-local-1", mfaEnabled: true })

      const res = await verifyWebauthnRegistration(userId, TENANT, {
        response: { id: "cred-id-abc" } as any,
        name: "YubiKey 5C",
      })

      expect(res.verified).toBe(true)
      expect(res.credentialId).toBe("wc-1")
      expect(tx.webauthnCredential.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            identityId: "id-local-1",
            credentialId: "cred-id-abc",
            name: "YubiKey 5C",
          }),
        }),
      )
      expect(tx.authIdentity.update).toHaveBeenCalledWith({
        where: { id: "id-local-1" },
        data: { mfaEnabled: true },
      })
    })

    it("rejette la vérification si le challenge a expiré ou a déjà été consommé", async () => {
      await expect(
        verifyWebauthnRegistration(userId, TENANT, { response: {} as any }),
      ).rejects.toThrow(AuthError)
    })
  })

  describe("Authentification (Authentication / Step-up)", () => {
    const credentialRecord = {
      id: "wc-1",
      identityId: "id-local-1",
      credentialId: "cred-id-abc",
      publicKey: Buffer.from([1, 2, 3, 4]),
      counter: BigInt(5),
      transports: '["internal"]',
    }

    it("génère les options d'authentification avec les credentials autorisés", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [credentialRecord],
      } as any)

      mockGenerateAuthOptions.mockResolvedValueOnce({
        challenge: "test-auth-challenge-456",
        allowCredentials: [{ id: "cred-id-abc" }],
      })

      const options = await generateWebauthnAuthenticationOptions(userId, TENANT)

      expect(options.challenge).toBe("test-auth-challenge-456")
      expect(webauthnChallengeStore.getAndConsume(`auth:${userId}`)).toBe("test-auth-challenge-456")
    })

    it("lève une erreur si aucune clé WebAuthn n'est enregistrée pour l'utilisateur", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce(mockIdentity as any)

      await expect(generateWebauthnAuthenticationOptions(userId, TENANT)).rejects.toThrow(AuthError)
    })

    it("vérifie l'authentification avec succès et met à jour le compteur", async () => {
      webauthnChallengeStore.set(`auth:${userId}`, "test-auth-challenge-456")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [credentialRecord],
      } as any)

      mockVerifyAuthResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: {
          newCounter: 6,
        },
      })

      vi.mocked(prisma.webauthnCredential.update).mockResolvedValueOnce({} as any)

      const res = await verifyWebauthnAuthentication(userId, TENANT, {
        response: { id: "cred-id-abc" } as any,
      })

      expect(res.verified).toBe(true)
      expect(prisma.webauthnCredential.update).toHaveBeenCalledWith({
        where: { id: "wc-1" },
        data: expect.objectContaining({
          counter: BigInt(6),
        }),
      })
    })

    it("accepte une clé sans compteur (0/0) : cas logiciel typique (Bitwarden, Windows Hello)", async () => {
      webauthnChallengeStore.set(`auth:${userId}`, "test-auth-challenge-456")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [{ ...credentialRecord, counter: BigInt(0) }],
      } as any)

      mockVerifyAuthResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: {
          newCounter: 0,
        },
      })

      vi.mocked(prisma.webauthnCredential.update).mockResolvedValueOnce({} as any)

      const res = await verifyWebauthnAuthentication(userId, TENANT, {
        response: { id: "cred-id-abc" } as any,
      })

      expect(res.verified).toBe(true)
      // Un compteur 0 ne doit ni déclencher counter_replay, ni écraser un éventuel compteur stocké.
      expect(prisma.webauthnCredential.update).toHaveBeenCalledWith({
        where: { id: "wc-1" },
        data: { lastUsedAt: expect.any(Date) },
      })
    })

    it("rejette un compteur en recul strictement positif (rejeu/copie)", async () => {
      webauthnChallengeStore.set(`auth:${userId}`, "test-auth-challenge-456")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [credentialRecord],
      } as any)

      mockVerifyAuthResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: {
          newCounter: 5,
        },
      })

      await expect(
        verifyWebauthnAuthentication(userId, TENANT, {
          response: { id: "cred-id-abc" } as any,
        }),
      ).rejects.toThrow(AuthError)

      expect(prisma.webauthnCredential.update).not.toHaveBeenCalled()
    })

    it("rejette une clé inconnue pour ce compte", async () => {
      webauthnChallengeStore.set(`auth:${userId}`, "test-auth-challenge-456")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [credentialRecord],
      } as any)

      await expect(
        verifyWebauthnAuthentication(userId, TENANT, {
          response: { id: "wrong-credential-id" } as any,
        }),
      ).rejects.toThrow(AuthError)
    })
  })

  describe("Gestion des Credentials (Listing & Deletion)", () => {
    it("liste les credentials WebAuthn de l'utilisateur", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [
          { id: "wc-1", name: "Touch ID", credentialId: "cid-1", createdAt: new Date() },
        ],
      } as any)

      const creds = await listUserWebauthnCredentials(userId)
      expect(creds).toHaveLength(1)
      expect(creds[0]?.name).toBe("Touch ID")
    })

    it("supprime un credential et désactive mfaEnabled si aucun autre facteur n'existe", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        mfaSecretEnc: null,
        webauthnCredentials: [{ id: "wc-1" }],
      } as any)

      vi.mocked(prisma.webauthnCredential.delete).mockResolvedValueOnce({} as any)
      vi.mocked(prisma.authIdentity.update).mockResolvedValueOnce({} as any)

      await deleteUserWebauthnCredential(userId, "wc-1")

      expect(prisma.webauthnCredential.delete).toHaveBeenCalledWith({ where: { id: "wc-1" } })
      expect(prisma.authIdentity.update).toHaveBeenCalledWith({
        where: { id: "id-local-1" },
        data: { mfaEnabled: false },
      })
    })

    it("refuse de supprimer un credential appartenant à une autre identité (IDOR)", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [{ id: "wc-other" }],
      } as any)

      await expect(deleteUserWebauthnCredential(userId, "wc-mine")).rejects.toThrow(AuthError)
      expect(prisma.webauthnCredential.delete).not.toHaveBeenCalled()
    })

    it("émet les évènements d'audit auth.webauthn.registered et auth.webauthn.deleted", async () => {
      const { eventBus } = await import("../../../lib/event-bus")
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValueOnce({
        ...mockIdentity,
        webauthnCredentials: [{ id: "wc-1", name: "YubiKey" }],
      } as any)
      vi.mocked(prisma.webauthnCredential.delete).mockResolvedValueOnce({} as any)

      await deleteUserWebauthnCredential(userId, "wc-1")

      expect(eventBus.emit).toHaveBeenCalledWith("auth.webauthn.deleted", {
        userId,
        credentialId: "wc-1",
        name: "YubiKey",
      })
    })
  })
})