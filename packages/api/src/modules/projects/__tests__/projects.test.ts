import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { projectsService } from "../service";
import { registerProjectRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";

vi.mock("../service", () => ({
  projectsService: { createProject: vi.fn() },
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";

describe("POST /api/projects", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerProjectRoutes(app);
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


  it("devrait créer un projet avec des données valides", async () => {
    const mockProject = { id: "proj-1", name: "Mon projet", description: "Description" };
    vi.mocked(projectsService.createProject).mockResolvedValue(mockProject as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: { name: "Project1", description: "Simple de projet de E-commerce" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockProject);
    expect(projectsService.createProject).toHaveBeenCalledWith({
      name: "Project1",
      description: "Simple de projet de E-commerce",
    });
  });

  it("devrait accepter un projet sans description (champ optionnel)", async () => {
    const mockProject = { id: "proj-1", name: "Mon projet" };
    vi.mocked(projectsService.createProject).mockResolvedValue(mockProject as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: { name: "Project1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockProject);
  });

  it("devrait retourner 400 si le nom est vide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: { name: "", description: "Simple de projet de E-commerce" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("details");
  });

  it("devrait retourner 400 si le nom est manquant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: { description: "Simple de projet de E-commerce" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("devrait retourner 400 si le nom n'est pas une chaîne", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
      payload: { name: 12343 },
    });

    expect(response.statusCode).toBe(400);
  });
    
  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Project1" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
      payload: { name: "Project1" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 403 pour un viewer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockViewerToken}` },
      payload: { name: "Project1" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("devrait accepter un owner", async () => {
    vi.mocked(projectsService.createProject).mockResolvedValue({
      id: "proj-1",
      name: "Project1",
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
      payload: { name: "Project" },
    });

    expect(response.statusCode).toBe(200);
  });
});