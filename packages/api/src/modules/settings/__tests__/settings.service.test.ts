import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockApplyDomainToCaddy } = vi.hoisted(() => ({
  mockPrisma: {
    settings: { upsert: vi.fn() },
  },
  mockApplyDomainToCaddy: vi.fn(),
}));

vi.mock("../../../lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../caddy-domain", () => ({
  applyDomainToCaddy: mockApplyDomainToCaddy,
}));


import { settingsService } from "../service";

const SINGLETON_ID = "singleton";

describe("SettingsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("get", () => {
    it("crée la ligne singleton via upsert si elle n'existe pas encore", async () => {
      mockPrisma.settings.upsert.mockResolvedValue({
        id: SINGLETON_ID,
        domain: null,
        updatedAt: new Date(),
      });

      const result = await settingsService.get();

      expect(result).toEqual({ domain: null });
      expect(mockPrisma.settings.upsert).toHaveBeenCalledWith({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        update: {},
      });
      expect(mockApplyDomainToCaddy).not.toHaveBeenCalled();
    });

    it("renvoie le domaine existant sans le modifier", async () => {
      mockPrisma.settings.upsert.mockResolvedValue({
        id: SINGLETON_ID,
        domain: "ops.exemple.com",
        updatedAt: new Date(),
      });

      const result = await settingsService.get();

      expect(result).toEqual({ domain: "ops.exemple.com" });
    });
  });

  describe("setDomain", () => {
    it("applique Caddy PUIS persiste en base, dans cet ordre précis", async () => {
      mockApplyDomainToCaddy.mockResolvedValue(undefined);
      mockPrisma.settings.upsert.mockResolvedValue({
        id: SINGLETON_ID,
        domain: "ops.exemple.com",
        updatedAt: new Date(),
      });

      const result = await settingsService.setDomain("ops.exemple.com");

      expect(result).toEqual({ domain: "ops.exemple.com" });
      expect(mockApplyDomainToCaddy).toHaveBeenCalledWith("ops.exemple.com");
      expect(mockPrisma.settings.upsert).toHaveBeenCalledWith({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, domain: "ops.exemple.com" },
        update: { domain: "ops.exemple.com" },
      });


      const caddyCallOrder = mockApplyDomainToCaddy.mock.invocationCallOrder[0]!;
      const dbCallOrder = mockPrisma.settings.upsert.mock.invocationCallOrder[0]!;
      expect(caddyCallOrder).toBeLessThan(dbCallOrder);
    });

    it("ne persiste RIEN en base si Caddy refuse le domaine", async () => {
      mockApplyDomainToCaddy.mockRejectedValue(
        new Error("Caddy: route web échouée (500)"),
      );

      await expect(
        settingsService.setDomain("ops.exemple.com"),
      ).rejects.toThrow("Caddy: route web échouée (500)");

     
      expect(mockPrisma.settings.upsert).not.toHaveBeenCalled();
    });

    it("propage fidèlement le message d'erreur de Caddy (pas de erreur générique)", async () => {
      mockApplyDomainToCaddy.mockRejectedValue(
        new Error("Impossible de joindre l'API admin Caddy"),
      );

      await expect(
        settingsService.setDomain("ops.exemple.com"),
      ).rejects.toThrow("Impossible de joindre l'API admin Caddy");
    });
  });
});
