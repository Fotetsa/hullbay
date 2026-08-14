import { describe, it, expect, vi, beforeEach } from "vitest";
import { finalizeClusterStep, type ProvisionInput } from "../provision-server";
import { prisma } from "../../lib/prisma";
import { eventBus } from "../../lib/event-bus";


vi.mock("../../lib/prisma", () => ({
  prisma: {
    cluster: {
      update: vi.fn(),
    },
  },
}));

vi.mock("../../lib/event-bus", () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

const baseInput: ProvisionInput = {
  serverId: "server-1",
  host: "203.0.113.0",
  port: 22,
  user: "root",
  role: "manager",
  credential: { type: "password", password: "unused" },
  clusterId: "cluster-1",
  isNewCluster: true,
};

describe("provision-server — finalizeClusterStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("met à jour le cluster avec les bonnes URLs et le statut ready en UN SEUL appel atomique", async () => {
    vi.mocked(prisma.cluster.update).mockResolvedValue({} as any);

    await finalizeClusterStep.run(baseInput, {
      shared: { isNewCluster: true },
    } as any);

    const updateMock = vi.mocked(prisma.cluster.update);
    expect(updateMock).toHaveBeenCalledTimes(1);

    const updateCall = updateMock.mock.calls[0];
    expect(updateCall).toBeDefined();

    const callArg = updateCall?.[0] as any;
    expect(callArg).toBeDefined();

    expect(callArg.data.dockerHost).toBe("tcp://203.0.113.0:2375");
    expect(callArg.data.caddyAdminUrl).toBe("http://203.0.113.0:2019");
    expect(callArg.data.status).toBe("ready");

    // Vérification de la sécurité (pas de typo dans l'URL - Issue #84)
    expect(callArg.data.caddyAdminUrl).toMatch(/^https?:\/\/.+:\d+$/);
    expect(callArg.data.caddyAdminUrl).not.toContain("htpp://");
    expect(callArg.data.caddyAdminUrl).not.toContain("htpps://");


    expect(eventBus.emit).toHaveBeenCalledWith(
      "cluster.status",
      expect.objectContaining({
        clusterId: "cluster-1",
        from: "pending",
        to: "ready",
      }),
    );
  });

  it("ne touche pas au cluster si ce n'est pas un nouveau cluster", async () => {
    await finalizeClusterStep.run(baseInput, {
      shared: { isNewCluster: false },
    } as any);

    expect(prisma.cluster.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
