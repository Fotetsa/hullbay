import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerReconcilerRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import * as rebuildModule from "../rebuild";


vi.mock("../rebuild", () => ({
  rebuildFromDocker: vi.fn(),
}));

vi.mock("../service", () => ({
    ReconcilerService: class {
        reconcile = vi.fn();
    }
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";

describe("POST /api/rebuild-from-docker", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerReconcilerRoutes(app);
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
      if (token === mockOperatorToken) return { sub: "operator-id", role: "operator", mfaEnabled: true };
      if (token === mockViewerToken) return { sub: "viewer-id", role: "viewer", mfaEnabled: true };
      if (token === mockNoMfaToken) return { sub: "no-mfa-id", role: "operator", mfaEnabled: false };
      throw new Error("Token invalide");
    });
  });
    
  it("devrait reconstruire depuis Docker avec un token operator", async () => {
    const mockResult = { rebuilt: 3, errors: 0 };
    vi.mocked(rebuildModule.rebuildFromDocker).mockResolvedValue(mockResult as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ...mockResult });
    expect(rebuildModule.rebuildFromDocker).toHaveBeenCalledTimes(1);
  });

  it("devrait accepter un owner", async () => {
    vi.mocked(rebuildModule.rebuildFromDocker).mockResolvedValue({} as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
    
  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 403 pour un viewer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});
