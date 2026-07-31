// packages/api/src/modules/settings/__tests__/settings.test.ts

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
import { registerSettingsRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";

// ── Mocks ─────────────────────────────────────────────────────────────────
// Même logique que servers.test.ts : on ne teste JAMAIS la vraie base Postgres
// ici (ça, c'est le rôle d'un test manuel ou d'un futur test "service" dédié).
// On mocke settingsService entièrement, pour isoler ce qu'on veut réellement
// vérifier dans CE fichier : le comportement HTTP (routes, rôles, validation).
const { mockSettingsService } = vi.hoisted(() => ({
  mockSettingsService: {
    get: vi.fn(),
    setDomain: vi.fn(),
  },
}));

vi.mock("../service", () => ({
  settingsService: mockSettingsService,
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

describe("Routes /api/settings/domain", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerSettingsRoutes(app);
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

  // ── GET /api/settings/domain ─────────────────────────────────────────

  describe("GET /api/settings/domain", () => {
    it("devrait retourner domain: null tant que rien n'a été configuré", async () => {
      mockSettingsService.get.mockResolvedValue({ domain: null });

      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOwnerToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ domain: null });
    });

    it("devrait retourner le domaine une fois configuré", async () => {
      mockSettingsService.get.mockResolvedValue({ domain: "ops.exemple.com" });

      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOwnerToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ domain: "ops.exemple.com" });
    });

    it("devrait retourner 401 sans token", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
      });

      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 401 avec un token invalide", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockInvalidToken}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 403 pour un operator", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOperatorToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(mockSettingsService.get).not.toHaveBeenCalled();
    });

    it("devrait retourner 403 pour un viewer", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockViewerToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(mockSettingsService.get).not.toHaveBeenCalled();
    });
  });

  // ── POST /api/settings/domain ────────────────────────────────────────

  describe("POST /api/settings/domain", () => {
    it("devrait définir un domaine valide et renvoyer 200", async () => {
      mockSettingsService.setDomain.mockResolvedValue({
        domain: "ops.exemple.com",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOwnerToken}` },
        payload: { domain: "ops.exemple.com" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ domain: "ops.exemple.com" });
      expect(mockSettingsService.setDomain).toHaveBeenCalledWith(
        "ops.exemple.com",
      );
    });

    it.each([
      "ops.exemple.com",
      "mon-site.io",
      "sub.exemple.co.uk", // vrai TLD à deux niveaux (co.uk) reconnu par la Public Suffix List
    ])(
      "devrait accepter le domaine syntaxiquement valide : %s",
      async (domain) => {
        mockSettingsService.setDomain.mockResolvedValue({ domain });

        const response = await app.inject({
          method: "POST",
          url: "/api/settings/domain",
          headers: { authorization: `Bearer ${mockOwnerToken}` },
          payload: { domain },
        });

        expect(response.statusCode).toBe(200);
        expect(mockSettingsService.setDomain).toHaveBeenCalledWith(domain);
      },
    );

    it.each([
      ["contient des espaces", "pas un domaine valide"],
      ["commence par un tiret", "-ops.exemple.com"],
      ["label vide (double point)", "ops..exemple.com"],
      ["finit par un tiret", "ops.exemple.com-"],
      ["pas de TLD du tout", "localhost"],
      // Cas régressif : point manquant avant le TLD. Un simple regex laissait
      // passer ceci en interprétant "exemplecom" comme un TLD de 10 lettres.
      // tldts sait que "exemplecom" n'est PAS un vrai suffixe public (ICANN).
      ["TLD inexistant (point manquant)", "ops.exemplecom"],
      ["TLD totalement inventé", "mon-site.faux-tld-invente"],
    ])(
      "devrait retourner 400 si le domaine est mal formé (%s)",
      async (_label, domain) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/settings/domain",
          headers: { authorization: `Bearer ${mockOwnerToken}` },
          payload: { domain },
        });

        expect(response.statusCode).toBe(400);
        expect(mockSettingsService.setDomain).not.toHaveBeenCalled();
      },
    );

    it("devrait retourner 400 si domain est absent du body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOwnerToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(mockSettingsService.setDomain).not.toHaveBeenCalled();
    });

    it("devrait retourner 401 sans token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        payload: { domain: "ops.exemple.com" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("devrait retourner 403 pour un operator", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOperatorToken}` },
        payload: { domain: "ops.exemple.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(mockSettingsService.setDomain).not.toHaveBeenCalled();
    });

    it("devrait retourner 403 pour un viewer", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockViewerToken}` },
        payload: { domain: "ops.exemple.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(mockSettingsService.setDomain).not.toHaveBeenCalled();
    });

    it("devrait retourner 400 si le service lève une erreur", async () => {
      // Anticipe l'étape 4 (appel à l'API admin Caddy) : quand setDomain()
      // pourra échouer pour de vraies raisons métier, ce test restera valide
      // sans qu'on ait besoin de le réécrire.
      mockSettingsService.setDomain.mockRejectedValue(
        new Error("Caddy injoignable"),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/settings/domain",
        headers: { authorization: `Bearer ${mockOwnerToken}` },
        payload: { domain: "ops.exemple.com" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Caddy injoignable" });
    });
  });
});
