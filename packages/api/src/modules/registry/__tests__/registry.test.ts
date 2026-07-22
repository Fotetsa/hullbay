import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registryService } from "../service";
import { registerRegistryRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import { eventBus } from "../../../lib/event-bus";

const { mockRegistryService, mockEventBus } = vi.hoisted(() => ({
  mockRegistryService: {
    set: vi.fn(),
  },
  mockEventBus: {
    emit: vi.fn(),
  },
}));

vi.mock("../service", () => ({
  registryService: { set: vi.fn() },
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

vi.mock("../../../lib/event-bus", () => ({
  eventBus: { emit: vi.fn() },
}));

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";

describe("POST /api/registry", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerRegistryRoutes(app);
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
    
  it("devrait créer un credential avec des données valides", async () => {
    const mockCred = { id: "1", registry: "ghcr.io", username: "KamerLink" };
    vi.mocked(registryService.set).mockResolvedValue(mockCred as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockCred);
    expect(registryService.set).toHaveBeenCalledWith(
      "ghcr.io",
      "KamerLink",
      "ghp_abc123",
    );
    expect(eventBus.emit).toHaveBeenCalledWith("registry.set", {
      userId: "owner-id",
      registry: "ghcr.io",
    });
  });

  it("devrait utiliser ghcr.io par défaut si registry n'est pas fourni", async () => {
    const mockCred = { id: "1", registry: "ghcr.io", username: "KamerLink" };
    vi.mocked(registryService.set).mockResolvedValue(mockCred as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(registryService.set).toHaveBeenCalledWith(
      "ghcr.io",
      "KamerLink",
      "ghp_abc123",
    );
  });
    
  it("devrait retourner 400 si username est vide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("devrait retourner 400 si token est vide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("devrait retourner 400 si username est manquant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("devrait retourner 400 si token est manquant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
      },
    });

    expect(response.statusCode).toBe(400);
  });
    
  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 403 pour un operator", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("devrait retourner 403 pour un viewer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockViewerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(403);
  });
    
  it("devrait retourner 500 si le service échoue", async () => {
    vi.mocked(registryService.set).mockRejectedValue(
      new Error("Erreur base de données"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/registry",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: {
        registry: "ghcr.io",
        username: "KamerLink",
        token: "ghp_abc123",
      },
    });

    expect(response.statusCode).toBe(500);
  });
});
