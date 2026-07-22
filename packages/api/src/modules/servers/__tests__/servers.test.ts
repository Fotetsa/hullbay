// packages/api/src/modules/servers/__tests__/servers.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerServersRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";


const { mockServersService, mockDockerMethods } = vi.hoisted(() => ({
  mockServersService: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    hasManager: vi.fn(),
  },
  mockDockerMethods: {
    listNodes: vi.fn(),
    managerHealth: vi.fn(),
    drainNode: vi.fn(),
    removeNode: vi.fn(),
    setNodeRole: vi.fn(),
  },
}));


vi.mock("../service", () => ({
  serversService: mockServersService,
}));

vi.mock("../../docker-engine/service", () => {
  return {
    DockerEngineService: class {
      constructor() {
        return mockDockerMethods;
      }
    },
  };
});

vi.mock("../../../workflows/provision-server", () => ({
  provisionServerWorkflow: vi.fn(),
}));


vi.mock("../../../lib/event-bus", () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";
const mockNoMfaToken = "mock_no_mfa_token";

describe("GET /api/servers", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerServersRoutes(app);
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

  it("devrait retourner la liste des serveurs avec les infos Swarm", async () => {
    const mockServers = [
      { id: "server-1", name: "prod-1", ip: "192.168.1.10" },
      { id: "server-2", name: "prod-2", ip: "192.168.1.11" },
    ];
    const mockNodes = [{ id: "node-1" }, { id: "node-2" }];
    const mockManagers = { total: 1, reachable: 1, quorumOk: true };

    mockServersService.list.mockResolvedValue(mockServers);
    mockDockerMethods.listNodes.mockResolvedValue(mockNodes);
    mockDockerMethods.managerHealth.mockResolvedValue(mockManagers);

    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      servers: mockServers,
      swarmNodes: 2,
      managers: mockManagers,
    });
  });

  it("devrait continuer si Docker/Swarm échoue", async () => {
    const mockServers = [
      { id: "server-1", name: "prod-1", ip: "192.168.1.10" },
    ];

    mockServersService.list.mockResolvedValue(mockServers);
    mockDockerMethods.listNodes.mockRejectedValue(new Error("Swarm inactif"));
    mockDockerMethods.managerHealth.mockRejectedValue(
      new Error("Swarm inactif"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      servers: mockServers,
      swarmNodes: 0,
      managers: { total: 0, reachable: 0, quorumOk: false },
    });
  });

  it("devrait retourner un tableau vide si aucun serveur n'existe", async () => {
    mockServersService.list.mockResolvedValue([]);
    mockDockerMethods.listNodes.mockResolvedValue([]);
    mockDockerMethods.managerHealth.mockResolvedValue({
      total: 0,
      reachable: 0,
      quorumOk: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      servers: [],
      swarmNodes: 0,
      managers: { total: 0, reachable: 0, quorumOk: false },
    });
  });

  it("devrait retourner 401 sans token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 401 avec un token invalide", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockInvalidToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("devrait retourner 403 pour un operator", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockOperatorToken}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it("devrait retourner 403 pour un viewer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/servers",
      headers: { authorization: `Bearer ${mockViewerToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});
