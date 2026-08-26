import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerReconcilerRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import * as rebuildModule from "../rebuild";
import { prisma } from "../../../lib/prisma";

// 1. Mock du module de rebuild
vi.mock("../rebuild", () => ({
  rebuildFromDocker: vi.fn(),
}));

// 2. Mock du service de réconciliation
vi.mock("../service", () => ({
  ReconcilerService: class {
    reconcile = vi.fn();
  },
}));

// 3. Mock du service d'authentification
vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    cluster: {
      findMany: vi.fn(),
    },
  },
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
  }, 90000);
  // Timeout élevé (90s, au lieu du défaut Vitest) : ce beforeAll construit une
  // app Fastify complète avec import en cascade de plusieurs modules lourds
  // (docker-engine, workflows, database). En local, sur un disque monté
  // Windows plus lent qu'un disque Linux natif, ce chargement peut
  // dépasser largement ce qu'il prend en CI. 90s laisse une marge confortable
  // même en cas de contention, sans masquer un vrai blocage infini (qui, lui,
  // dépasserait n'importe quelle valeur raisonnable et resterait détectable).

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(prisma.cluster.findMany).mockResolvedValue([
      { id: "mock-cluster-id" },
    ] as any);

    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === mockOwnerToken)
        return { sub: "owner-id", role: "owner", mfaEnabled: true };
      if (token === mockOperatorToken)
        return { sub: "operator-id", role: "operator", mfaEnabled: true };
      if (token === mockViewerToken)
        return { sub: "viewer-id", role: "viewer", mfaEnabled: true };
      if (token === mockNoMfaToken)
        return { sub: "no-mfa-id", role: "operator", mfaEnabled: false };
      throw new Error("Token invalide");
    });
  });

  it("devrait reconstruire depuis Docker avec un token operator", async () => {
    const mockResult = { projects: 3, nodes: 5, edges: 2, degraded: 0 };
    vi.mocked(rebuildModule.rebuildFromDocker).mockResolvedValue(
      mockResult as any,
    );

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
    vi.mocked(rebuildModule.rebuildFromDocker).mockResolvedValue({
      projects: 1,
      nodes: 1,
      edges: 0,
      degraded: 0,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/api/rebuild-from-docker",
      headers: { authorization: `Bearer ${mockOwnerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("nodes");
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
