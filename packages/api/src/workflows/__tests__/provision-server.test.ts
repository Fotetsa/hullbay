import { describe, it, expect, vi, beforeEach } from "vitest";
import { finalizeClusterStep, type ProvisionInput } from "../provision-server";
import { prisma } from "../../lib/prisma";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    cluster: {
      update: vi.fn(),
    },
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

  it("écrit une caddyAdminUrl avec un schéma http(s) valide", async () => {
    vi.mocked(prisma.cluster.update).mockResolvedValue({} as any);


    await finalizeClusterStep.run(baseInput, {
      shared: { isNewCluster: true },
    } as any);

    const updateMock = vi.mocked(prisma.cluster.update);
    expect(updateMock).toHaveBeenCalledTimes(1);

    const callArgs = updateMock.mock.calls[0];
    expect(callArgs).toBeDefined();

    const call = callArgs![0] as {
      data: { caddyAdminUrl: string; dockerHost: string; status: string };
    };

    // Vérifie que l'URL a un schéma valide et un port
    expect(call.data.caddyAdminUrl).toMatch(/^https?:\/\/.+:\d+$/);
    expect(call.data.caddyAdminUrl).not.toContain("htpp://");
    expect(call.data.caddyAdminUrl).not.toContain("htpps://");
  });

  it("inclut bien l'host fourni dans dockerHost et caddyAdminUrl", async () => {
    vi.mocked(prisma.cluster.update).mockResolvedValue({} as any);


    await finalizeClusterStep.run(baseInput, {
      shared: { isNewCluster: true },
    } as any);

    const updateMock = vi.mocked(prisma.cluster.update);
    expect(updateMock).toHaveBeenCalledTimes(1);

    const callArgs = updateMock.mock.calls[0];
    expect(callArgs).toBeDefined();

    const call = callArgs![0] as {
      data: { caddyAdminUrl: string; dockerHost: string; status: string };
    };

    expect(call.data.dockerHost).toBe("tcp://203.0.113.0:2375");


    expect(call.data.caddyAdminUrl).toBe("http://203.0.113.0:2019");
    expect(call.data.status).toBe("ready");
  });

  it("ne touche pas au cluster si ce n'est pas un nouveau cluster", async () => {
    // Ici, isNewCluster est undefined (falsy), donc le update ne doit pas être appelé
    await finalizeClusterStep.run(baseInput, {
      shared: {},
    } as any);

    expect(prisma.cluster.update).not.toHaveBeenCalled();
  });
});
