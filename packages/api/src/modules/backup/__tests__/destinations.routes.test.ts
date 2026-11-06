import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { buildTestApp } from "../../../__tests__/helpers/build-test-app"
import { registerAuthGuard } from "../../auth/routes"
import { authService } from "../../auth/service"
import { registerBackupDestinationsRoutes } from "../destinations.routes"

const { mockService } = vi.hoisted(() => ({
  mockService: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.setConfig({ testTimeout: 30000, hookTimeout: 120000 })

vi.mock("../destinations.service", () => ({
  backupDestinationService: mockService,
}))

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}))

const ownerToken = "owner_token"
const operatorToken = "operator_token"

const view = {
  id: "dest_1",
  name: "prod",
  protocol: "s3",
  basePath: "hullbay",
  projectId: null,
  lastTestedAt: null,
  capabilities: null,
  createdAt: "2026-10-25T10:00:00.000Z",
}

describe("routes /api/backup/destinations", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app)
        await registerBackupDestinationsRoutes(app)
      },
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === ownerToken)
        return { sub: "owner-id", role: "owner", mfaEnabled: true } as never
      if (token === operatorToken)
        return { sub: "operator-id", role: "operator", mfaEnabled: true } as never
      throw new Error("Token invalide")
    })
  })

  it("crée une destination en 201 sans exposer de secret", async () => {
    mockService.create.mockResolvedValue(view)

    const response = await app.inject({
      method: "POST",
      url: "/api/backup/destinations",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "prod",
        basePath: "hullbay",
        config: {
          protocol: "s3",
          bucket: "backups",
          accessKeyId: "AKIA",
          secretAccessKey: "s3cr3t",
        },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual(view)
    expect(response.body).not.toContain("s3cr3t")
    expect(response.body).not.toContain("AKIA")
  })

  it("refuse à un opérateur de créer une destination (credentials sensibles)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/destinations",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        name: "prod",
        basePath: "hullbay",
        config: {
          protocol: "s3",
          bucket: "b",
          accessKeyId: "AKIA",
          secretAccessKey: "s3cr3t",
        },
      },
    })
    expect(response.statusCode).toBe(403)
    expect(mockService.create).not.toHaveBeenCalled()
  })

  it("valide le corps avant d'appeler le service", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/destinations",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "prod", basePath: "/absolu", config: { protocol: "s3" } },
    })
    expect(response.statusCode).toBe(400)
    expect(mockService.create).not.toHaveBeenCalled()
  })

  it("liste les destinations du tenant courant", async () => {
    mockService.list.mockResolvedValue([view])
    const response = await app.inject({
      method: "GET",
      url: "/api/backup/destinations",
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([view])
  })

  it("autorise un operator à lire la vue publique (aucun secret)", async () => {
    mockService.list.mockResolvedValue([view])
    const response = await app.inject({
      method: "GET",
      url: "/api/backup/destinations",
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.stringify(response.json())).not.toContain("secret")
  })

  it("supprime en 204", async () => {
    mockService.remove.mockResolvedValue(undefined)
    const response = await app.inject({
      method: "DELETE",
      url: "/api/backup/destinations/dest_1",
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(response.statusCode).toBe(204)
    expect(mockService.remove).toHaveBeenCalledWith("dest_1", "tenant-default")
  })
})
