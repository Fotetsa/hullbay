import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerUpdatesRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";

const { mockUpdaterService, mockClusterService, mockResolveEnvironment } =
  vi.hoisted(() => ({
    mockUpdaterService: {
      check: vi.fn(),
      current: vi.fn(),
      history: vi.fn(),
      status: vi.fn(),
      apply: vi.fn(),
      rollback: vi.fn(),
      setChannel: vi.fn(),
    },
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
    mockResolveEnvironment: vi.fn(
      (): "development" | "test" | "production" => "production",
    ),
  }));

vi.mock("../updater", () => ({
  updaterService: mockUpdaterService,
}));

vi.mock("../../system/service", () => ({
  resolveEnvironment: mockResolveEnvironment,
}));

vi.mock("../../../lib/event-bus", () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

const ownerToken = "owner-token";
const operatorToken = "operator-token";
const viewerToken = "viewer-token";

describe("Routes /api/updates", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerUpdatesRoutes(app);
      },
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveEnvironment.mockReturnValue("production");
    vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
      if (token === ownerToken) return { sub: "owner-id", role: "owner", mfaEnabled: true };
      if (token === operatorToken) return { sub: "op-id", role: "operator", mfaEnabled: true };
      if (token === viewerToken) return { sub: "viewer-id", role: "viewer", mfaEnabled: true };
      throw new Error("Token invalide");
    });
  });

  it("GET /api/updates/check → 200 pour un owner", async () => {
    mockUpdaterService.check.mockResolvedValue({
      currentVersion: "1.2.2",
      updateChannel: "stable",
      updateAvailable: true,
      latestVersion: "1.2.3",
      latest: { tag: "v1.2.3", version: "1.2.3" },
      lastCheckAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/updates/check",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updateAvailable).toBe(true);
  });

  it("GET /api/updates/check → 401 sans token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/updates/check" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/updates/check → 403 pour operator et viewer (owner-only)", async () => {
    for (const token of [operatorToken, viewerToken]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/updates/check",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(mockUpdaterService.check).not.toHaveBeenCalled();
  });

  it("GET /api/updates/history → liste paginée pour un owner", async () => {
    mockUpdaterService.history.mockResolvedValue({
      items: [{ id: "u1", status: "success", fromVersion: "1.2.1", toVersion: "1.2.2" }],
      total: 1,
      hasMore: false,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/updates/history?limit=5&offset=10&status=failed",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [{ id: "u1", status: "success", fromVersion: "1.2.1", toVersion: "1.2.2" }],
      total: 1,
      hasMore: false,
    });
    expect(mockUpdaterService.history).toHaveBeenCalledWith({ limit: 5, offset: 10, status: "failed" });
  });

  it("GET /api/updates/history → 400 si status invalide", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/updates/history?status=quelquechose",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("GET /api/updates/status/:id → 404 si introuvable", async () => {
    mockUpdaterService.status.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/updates/status/nope",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/updates/apply → 202 et lance en arrière-plan", async () => {
    mockUpdaterService.apply.mockResolvedValue("update-9");

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/apply",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { channel: "stable" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: "update-9", status: "running" });
    expect(mockUpdaterService.apply).toHaveBeenCalledWith(
      { channel: "stable", version: undefined },
      "owner-id",
    );
  });

  it("POST /api/updates/apply → 409 si une update est déjà en cours", async () => {
    mockUpdaterService.apply.mockRejectedValue(new Error("Une mise à jour est déjà en cours (x)"));

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/apply",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });

  it("POST /api/updates/apply → 400 si version invalide", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/updates/apply",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { version: "n'importe quoi" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockUpdaterService.apply).not.toHaveBeenCalled();
  });

  it("POST /api/updates/apply → 403 pour operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/updates/apply",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it("PUT /api/updates/channel → 200 et persiste le canal", async () => {
    mockUpdaterService.setChannel.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "PUT",
      url: "/api/updates/channel",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { channel: "beta" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, channel: "beta" });
    expect(mockUpdaterService.setChannel).toHaveBeenCalledWith("beta");
  });

  it("PUT /api/updates/channel → 400 si canal invalide", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/updates/channel",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { channel: "nightly" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockUpdaterService.setChannel).not.toHaveBeenCalled();
  });

  it("PUT /api/updates/channel → 403 pour operator", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/updates/channel",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { channel: "beta" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("POST /api/updates/:id/rollback → 202 et renvoie l'id du pipeline rollback", async () => {
    // Le rollback crée un NOUVEL enregistrement (historique préservé) : le front
    // suit le pipeline via l'id renvoyé, pas l'id de l'update d'origine.
    mockUpdaterService.rollback.mockResolvedValue("rb-1");

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/update-9/rollback",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: "rb-1", status: "running" });
  });

  it("POST /api/updates/:id/rollback → 404 si introuvable", async () => {
    mockUpdaterService.rollback.mockRejectedValue(new Error("update introuvable"));

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/nope/rollback",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/updates/:id/rollback → 400 si l'update n'est pas annulable (déjà rollbackée)", async () => {
    mockUpdaterService.rollback.mockRejectedValue(new Error("déjà rollbacké"));

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/update-9/rollback",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "déjà rollbacké" });
  });

  it("POST /api/updates/apply → 409 hors production, même pour un owner", async () => {
    mockResolveEnvironment.mockReturnValue("development");

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/apply",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(mockUpdaterService.apply).not.toHaveBeenCalled();
  });

  it("PUT /api/updates/channel → 409 hors production", async () => {
    mockResolveEnvironment.mockReturnValue("development");

    const res = await app.inject({
      method: "PUT",
      url: "/api/updates/channel",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { channel: "beta" },
    });

    expect(res.statusCode).toBe(409);
    expect(mockUpdaterService.setChannel).not.toHaveBeenCalled();
  });

  it("POST /api/updates/:id/rollback → 409 hors production", async () => {
    mockResolveEnvironment.mockReturnValue("development");

    const res = await app.inject({
      method: "POST",
      url: "/api/updates/update-9/rollback",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(409);
    expect(mockUpdaterService.rollback).not.toHaveBeenCalled();
  });
});
