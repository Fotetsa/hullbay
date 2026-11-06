import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { buildTestApp } from "../../../__tests__/helpers/build-test-app"
import { registerAuthGuard } from "../../auth/routes"
import { authService } from "../../auth/service"
import { registerBackupRoutes } from "../routes"

const { mockPolicies, mockTargets, mockPrisma } = vi.hoisted(() => ({
  mockPolicies: {
    create: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    runNow: vi.fn(),
    testDestination: vi.fn(),
  },
  mockTargets: {
    createFromNode: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  },
  mockPrisma: {
    backupRun: { findMany: vi.fn() },
    backupArtifact: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}))

vi.setConfig({ testTimeout: 30000, hookTimeout: 120000 })

vi.mock("../policies.service", () => ({ backupPolicyService: mockPolicies }))
vi.mock("../targets.service", () => ({ backupTargetService: mockTargets }))
vi.mock("../../../lib/prisma", () => ({ prisma: mockPrisma }))
vi.mock("../../auth/service", () => ({ authService: { verifyToken: vi.fn() } }))

const ownerToken = "owner_token"
const operatorToken = "operator_token"
const viewerToken = "viewer_token"

describe("routes /api/backup", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app)
        await registerBackupRoutes(app)
      },
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === ownerToken)
        return { sub: "o", role: "owner", mfaEnabled: true } as never
      if (token === operatorToken)
        return { sub: "p", role: "operator", mfaEnabled: true } as never
      if (token === viewerToken)
        return { sub: "v", role: "viewer", mfaEnabled: true } as never
      throw new Error("Token invalide")
    })
  })

  it("crée une policy en 201 (operator)", async () => {
    mockPolicies.create.mockResolvedValue({ id: "pol_1" })
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/policies",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        targetId: "tgt_1",
        destinationId: "dst_1",
        strategyId: "postgres.pg_dump",
      },
    })
    expect(response.statusCode).toBe(201)
  })

  it("refuse un viewer sur la création de policy", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/policies",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: {
        targetId: "tgt_1",
        destinationId: "dst_1",
        strategyId: "postgres.pg_dump",
      },
    })
    expect(response.statusCode).toBe(403)
    expect(mockPolicies.create).not.toHaveBeenCalled()
  })

  it("retourne 202 sur run réussi et 422 sur échec", async () => {
    mockPolicies.runNow.mockResolvedValueOnce({ ok: true, runId: "run_1" })
    const ok = await app.inject({
      method: "POST",
      url: "/api/backup/policies/pol_1/run",
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(ok.statusCode).toBe(202)

    mockPolicies.runNow.mockResolvedValueOnce({ ok: false, runId: "run_2", errorCode: "verify_failed" })
    const ko = await app.inject({
      method: "POST",
      url: "/api/backup/policies/pol_1/run",
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(ko.statusCode).toBe(422)
    expect(ko.json()).toMatchObject({ errorCode: "verify_failed" })
  })

  it("réserve le test de destination à l'owner", async () => {
    mockPolicies.testDestination.mockResolvedValue({ ok: true, capabilities: {} })
    const operator = await app.inject({
      method: "POST",
      url: "/api/backup/destinations/dst_1/test",
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(operator.statusCode).toBe(403)

    const owner = await app.inject({
      method: "POST",
      url: "/api/backup/destinations/dst_1/test",
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(owner.statusCode).toBe(200)
  })

  it("sérialise la taille des artifacts en chaîne (BigInt)", async () => {
    mockPrisma.backupArtifact.findMany.mockResolvedValue([
      {
        id: "art_1",
        targetId: "tgt_1",
        destinationId: "dst_1",
        storageKey: "k",
        payloadFormat: "sql.gz",
        checksumSha256: "a".repeat(64),
        sizeBytes: 12345678901234567890n,
        engine: "postgres",
        engineVersion: "16",
        strategyId: "postgres.pg_dump",
        formatVersion: 1,
        committedAt: new Date("2026-10-25T10:00:00Z"),
      },
    ])
    const response = await app.inject({
      method: "GET",
      url: "/api/backup/artifacts",
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()[0].sizeBytes).toBe("12345678901234567890")
  })

  it("renvoie 501 sur restore (contrat réservé)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/artifacts/art_1/restore",
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({
      error: "not_implemented",
      code: "not_implemented",
    })
    expect(response.body).not.toMatch(/password|secret/i)
  })
})
