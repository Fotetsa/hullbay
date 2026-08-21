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
import { registerSecretsRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import { eventBus } from "../../../lib/event-bus";

// Le moteur Docker est résolu PAR CLUSTER via DockerEngineService.forCluster(),
// pas par un constructeur simple comme avant -- on mocke donc la méthode
// statique, pas le constructeur.
const { mockEngine } = vi.hoisted(() => ({
  mockEngine: {
    listManagedSecrets: vi.fn(),
    upsertSecret: vi.fn(),
    removeSecret: vi.fn(),
  },
}));

vi.mock("../../docker-engine/service", () => ({
  DockerEngineService: {
    forCluster: vi.fn(async () => mockEngine),
  },
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
const mockClusterId = "mock-cluster-id";

describe("Routes /api/clusters/:clusterId/secrets", () => {
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
      if (token === mockOwnerToken)
        return { sub: "owner-id", role: "owner", mfaEnabled: true };
      if (token === mockOperatorToken)
        return { sub: "operator-id", role: "operator", mfaEnabled: true };
      if (token === mockViewerToken)
        return { sub: "viewer-id", role: "viewer", mfaEnabled: true };
      throw new Error("Token invalide");
    });
  });

  describe("GET /api/clusters/:clusterId/secrets", () => {
    it("devrait lister les secrets d'un cluster précis", async () => {
      mockEngine.listManagedSecrets.mockResolvedValue([
        { id: "secret-1", name: "db_password" },
        { id: "secret-2", name: "api_key" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOwnerToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { id: "secret-1", name: "db_password" },
        { id: "secret-2", name: "api_key" },
      ]);
    });

    it("devrait accepter un operator", async () => {
      mockEngine.listManagedSecrets.mockResolvedValue([
        { id: "secret-1", name: "db_password" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { id: "secret-1", name: "db_password" },
      ]);
    });

    it("devrait retourner un tableau vide si aucun secret n'existe", async () => {
      mockEngine.listManagedSecrets.mockResolvedValue([]);

      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOwnerToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it("devrait retourner 401 sans token", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 401 avec un token invalide", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockInvalidToken}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 403 pour un viewer", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockViewerToken}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /api/clusters/:clusterId/secrets", () => {
    it("devrait créer un secret avec un token operator", async () => {
      mockEngine.upsertSecret.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { name: "db_password", value: "s3cr3t" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, name: "db_password" });
      expect(mockEngine.upsertSecret).toHaveBeenCalledWith(
        "db_password",
        "s3cr3t",
      );
    });

    it("devrait retourner 400 si le nom contient des caractères invalides", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { name: "mot de passe invalide!", value: "s3cr3t" },
      });
      expect(response.statusCode).toBe(400);
      expect(mockEngine.upsertSecret).not.toHaveBeenCalled();
    });

    it("devrait retourner 400 si value est vide", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { name: "db_password", value: "" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("devrait retourner 409 si le moteur Docker refuse (ex: secret en cours d'utilisation)", async () => {
      mockEngine.upsertSecret.mockRejectedValue(
        new Error("secret déjà référencé par un service actif"),
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { name: "db_password", value: "s3cr3t" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "secret déjà référencé par un service actif",
      });
    });

    it("devrait retourner 401 sans token", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        payload: { name: "db_password", value: "s3cr3t" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 403 pour un viewer", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockViewerToken}` },
        payload: { name: "db_password", value: "s3cr3t" },
      });
      expect(response.statusCode).toBe(403);
      expect(mockEngine.upsertSecret).not.toHaveBeenCalled();
    });

    it("S10-05: l'audit (eventBus) ne contient JAMAIS la valeur du secret", async () => {
      mockEngine.upsertSecret.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: `/api/clusters/${mockClusterId}/secrets`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { name: "db_password", value: "s3cr3t-V@leur-réelle" },
      });
      expect(response.statusCode).toBe(200);

      // Aucun événement émis ne porte la valeur — seulement nom/cluster/user.
      expect(eventBus.emit).toHaveBeenCalledWith("secret.set", {
        userId: "operator-id",
        clusterId: mockClusterId,
        name: "db_password",
      });
      const allEmits = JSON.stringify(vi.mocked(eventBus.emit).mock.calls);
      expect(allEmits).not.toContain("s3cr3t-V@leur-réelle");

      // La réponse HTTP non plus.
      expect(response.body).not.toContain("s3cr3t-V@leur-réelle");
    });
  });

  describe("DELETE /api/clusters/:clusterId/secrets/:name", () => {
    it("devrait supprimer un secret avec un token operator", async () => {
      mockEngine.removeSecret.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/clusters/${mockClusterId}/secrets/db_password`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(mockEngine.removeSecret).toHaveBeenCalledWith("db_password");
    });

    it("devrait retourner 409 si le moteur Docker refuse la suppression", async () => {
      mockEngine.removeSecret.mockRejectedValue(
        new Error("secret en cours d'utilisation"),
      );

      const response = await app.inject({
        method: "DELETE",
        url: `/api/clusters/${mockClusterId}/secrets/db_password`,
        headers: { authorization: `Bearer ${mockOperatorToken}` },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "secret en cours d'utilisation",
      });
    });

    it("devrait retourner 401 sans token", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/clusters/${mockClusterId}/secrets/db_password`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 403 pour un viewer", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/clusters/${mockClusterId}/secrets/db_password`,
        headers: { authorization: `Bearer ${mockViewerToken}` },
      });
      expect(response.statusCode).toBe(403);
      expect(mockEngine.removeSecret).not.toHaveBeenCalled();
    });
  });
});
