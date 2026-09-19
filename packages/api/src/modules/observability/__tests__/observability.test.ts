import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerObservabilityRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import { ObservabilityService, systemHealth } from "../service";

const { mockClusterService } = vi.hoisted(() => ({
  mockClusterService: {
    get: vi.fn(),
    getOrThrow: vi.fn(),
    getDefault: vi.fn(async () => ({
      id: "default-cluster",
      name: "Default",
      isDefault: true,
      dockerHost: "tcp://socket-proxy:2375",
      caddyAdminUrl: "http://caddy:2019",
      status: "ready",
    })),
    list: vi.fn(),
  },
}));

vi.mock("../../clusters/service", () => ({
  clusterService: mockClusterService,
}));

vi.mock("../service", () => ({
  ObservabilityService: { forCluster: vi.fn() },
  systemHealth: vi.fn(),
}));

vi.mock("../../auth/service", () => ({
    authService: { verifyToken: vi.fn() },
}));

const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";


describe("GET /api/health/cluster", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerObservabilityRoutes(app);
      },
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === mockViewerToken)
        return { sub: "viewer-id", role: "viewer", mfaEnabled:true };
      if (token === mockNoMfaToken) 
        return { sub: "no-mfa-id", role: "operator", mfaEnabled: false };
      
      throw new Error("Token invalide");
    });
  });

  it("devrait retourner la santé du cluster avec un token valide", async () => {
    const mockHealth = [
      {
        swarmActive: true,
        nodes: [{ id: "node-1" } as any],
        services: [{ id: "svc-1" } as any],
      },
    ];
    vi.mocked(systemHealth).mockResolvedValue(mockHealth as any);

    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clusters: mockHealth });
    expect(systemHealth).toHaveBeenCalledTimes(1);
  });

  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 500 si le service échoue", async () => {
    vi.mocked(systemHealth).mockRejectedValue(
      new Error("Docker socket inaccessible"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(500);
  });

  it("B5 — /api/drift retourne un objet { drift } (pas undefined)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/drift",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("drift");
    expect(Array.isArray(body.drift)).toBe(true);
  });
});