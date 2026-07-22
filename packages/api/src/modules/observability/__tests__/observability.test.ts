import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { observabilityService } from "../service";
import { registerObservabilityRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";

vi.mock("../service", () => ({
  observabilityService: {
    clusterHealth: vi.fn()
  },
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
    const mockHealth = {
      nodes: [{ id: "node-1" }],
      services: [{ id: "svc-1" }],
    };
    vi.mocked(observabilityService.clusterHealth).mockResolvedValue(mockHealth as any);

    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockHealth);
    expect(observabilityService.clusterHealth).toHaveBeenCalledTimes(1);
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
    vi.mocked(observabilityService.clusterHealth).mockRejectedValue(
      new Error("Docker socket inaccessible"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/health/cluster",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(500);
  });
});