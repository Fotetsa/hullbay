import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  finalizeClusterStep,
  deploySocketProxyStep,
  deployCaddyStep,
  type ProvisionInput,
} from "../provision-server";
import { prisma } from "../../lib/prisma";
import type { Step } from "../../lib/workflow";

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

describe("provision-server — déploiement sécurisé par défaut (#85)", () => {
  const execMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  function runCommands(step: Step<ProvisionInput>) {
    return step.run(baseInput, {
      shared: {
        hadExistingSwarm: false,
        session: { exec: execMock },
      },
    } as any).then(() => execMock.mock.calls.map((c) => String(c[0])));
  }

  it("socket-proxy : bind 127.0.0.1, jamais 0.0.0.0 ni port nu", async () => {
    const commands = await runCommands(deploySocketProxyStep);

    const dockerRun = commands.find((c) => c.includes("docker run -d"));
    expect(dockerRun).toBeDefined();
    expect(dockerRun).toContain("-p 127.0.0.1:2375:2375");
    expect(dockerRun).not.toContain("0.0.0.0:2375");
    expect(dockerRun).not.toContain("-p 2375:2375");
  });

  it("Caddy : port admin publié sur 127.0.0.1 de l'hôte (jamais 0.0.0.0 ni port nu)", async () => {
    const commands = await runCommands(deployCaddyStep);

    const dockerRun = commands.find((c) => c.includes("docker run -d"));
    expect(dockerRun).toBeDefined();
    expect(dockerRun).toContain("-p 127.0.0.1:2019:2019");
    expect(dockerRun).not.toContain("0.0.0.0:2019");
    expect(dockerRun).not.toContain("-p 2019:2019");
  });

  it("ne déploie rien sur un worker (pas un nouveau cluster manager)", async () => {
    await deploySocketProxyStep.run(
      { ...baseInput, role: "worker" } as any,
      {
        shared: { hadExistingSwarm: true, session: { exec: execMock } },
      } as any,
    );
    await deployCaddyStep.run(
      { ...baseInput, role: "worker" } as any,
      {
        shared: { hadExistingSwarm: true, session: { exec: execMock } },
      } as any,
    );
    expect(execMock).not.toHaveBeenCalled();
  });
});
