import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerSecretsRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";

const { mockEngine } = vi.hoisted(() => ({
  mockEngine: {
    listManagedSecrets: vi.fn(),
    upsertSecret: vi.fn(),
    removeSecret: vi.fn(),
  },
}));

vi.mock("../../docker-engine/service", () => ({
  DockerEngineService: class {
    constructor() {
      return mockEngine;
    }
  },
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";

describe("GET /api/secrets", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerSecretsRoutes(app);
      },
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === mockOwnerToken) return { sub: "owner-id", role: "owner", mfaEnabled: true };
      if (token === mockOperatorToken)
        return { sub: "operator-id", role: "operator", mfaEnabled: true };
      if (token === mockViewerToken)
        return { sub: "viewer-id", role: "viewer", mfaEnabled: true };

      if (token === mockNoMfaToken)
        return { sub: "no-mfa-id", role: "operator", mfaEnabled: false };
      throw new Error("Token invalide");
    });
  });
  it("devrait retourner la liste des secrets avec un token operator", async () => {
    const mockSecrets = [
      { id: "secret-1", name: "db_password" },
      { id: "secret-2", name: "api_key" },
    ];
    mockEngine.listManagedSecrets.mockResolvedValue(mockSecrets);

    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "secret-1", name: "db_password" },
      { id: "secret-2", name: "api_key" },
    ]);
  });

  it("devrait accepter un owner", async () => {
    const mockSecrets = [{ id: "secret-1", name: "db_password" }];
    mockEngine.listManagedSecrets.mockResolvedValue(mockSecrets);

    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: "secret-1", name: "db_password" }]);
  });

  it("devrait retourner un tableau vide si aucun secret n'existe", async () => {
    mockEngine.listManagedSecrets.mockResolvedValue([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 403 pour un viewer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});
