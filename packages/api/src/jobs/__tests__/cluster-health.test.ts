import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClusterService, mockForCluster } = vi.hoisted(() => ({
  mockClusterService: {
    list: vi.fn(),
    markUnhealthy: vi.fn(),
    markRecovered: vi.fn(),
  },
  mockForCluster: vi.fn(),
}));

vi.mock("../../modules/clusters/service", () => ({
  clusterService: mockClusterService,
}));
vi.mock("../../modules/docker-engine/service", () => ({
  DockerEngineService: { forCluster: mockForCluster },
}));

import {
  runClusterHealthCheck,
  resetHealthCountersForTests,
} from "../cluster-health";

function cluster(
  overrides: Partial<{ id: string; status: string; dockerHost: string }> = {},
) {
  return {
    id: "c1",
    name: "Cluster de test",
    status: "ready",
    dockerHost: "tcp://1.2.3.4:2375",
    ...overrides,
  };
}

describe("runClusterHealthCheck", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Les compteurs de vérifications consécutives vivent au niveau du
    // module et ne sont jamais touchés par les fonctions de réinitialisation
    // de vitest, qui ne connaissent que les simulacres. Sans cet appel, un
    // test hériterait silencieusement du compteur laissé par le précédent.
    resetHealthCountersForTests();
    mockClusterService.markUnhealthy.mockResolvedValue(true);
    mockClusterService.markRecovered.mockResolvedValue(true);
  });

  it("ne touche pas un cluster qui n'est pas prêt et n'a jamais été provisionné", async () => {
    mockClusterService.list.mockResolvedValue([
      cluster({ status: "pending", dockerHost: "" }),
    ]);

    await runClusterHealthCheck();

    expect(mockForCluster).not.toHaveBeenCalled();
    expect(mockClusterService.markUnhealthy).not.toHaveBeenCalled();
  });

  it("ne tente jamais de vérifier un cluster en échec qui n'a jamais eu d'adresse de connexion", async () => {
    mockClusterService.list.mockResolvedValue([
      cluster({ status: "failed", dockerHost: "" }),
    ]);

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockForCluster).not.toHaveBeenCalled();
    expect(mockClusterService.markRecovered).not.toHaveBeenCalled();
  });

  it("ne marque pas un cluster sain, même après un passage", async () => {
    mockClusterService.list.mockResolvedValue([cluster()]);
    mockForCluster.mockResolvedValue({
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 1, reachable: 1, quorumOk: true }),
    });

    await runClusterHealthCheck();

    expect(mockClusterService.markUnhealthy).not.toHaveBeenCalled();
  });

  it("ne marque pas un cluster après un seul échec, en dessous du seuil", async () => {
    mockClusterService.list.mockResolvedValue([cluster()]);
    mockForCluster.mockRejectedValue(new Error("injoignable"));

    await runClusterHealthCheck();

    expect(mockClusterService.markUnhealthy).not.toHaveBeenCalled();
  });

  it("marque le cluster défaillant après trois échecs consécutifs", async () => {
    mockClusterService.list.mockResolvedValue([cluster()]);
    mockForCluster.mockRejectedValue(new Error("injoignable"));

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockClusterService.markUnhealthy).toHaveBeenCalledTimes(1);
    expect(mockClusterService.markUnhealthy).toHaveBeenCalledWith("c1");
  });

  it("remet le compteur d'échecs à zéro dès qu'une vérification réussit à nouveau", async () => {
    mockClusterService.list.mockResolvedValue([cluster()]);
    mockForCluster.mockRejectedValueOnce(new Error("injoignable"));
    mockForCluster.mockRejectedValueOnce(new Error("injoignable"));
    mockForCluster.mockResolvedValueOnce({
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 1, reachable: 1, quorumOk: true }),
    });
    mockForCluster.mockRejectedValueOnce(new Error("injoignable"));
    mockForCluster.mockRejectedValueOnce(new Error("injoignable"));

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockClusterService.markUnhealthy).not.toHaveBeenCalled();
  });

  it("marque un quorum perdu comme défaillant, même si le Swarm répond encore", async () => {
    mockClusterService.list.mockResolvedValue([cluster()]);
    mockForCluster.mockResolvedValue({
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 3, reachable: 1, quorumOk: false }),
    });

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockClusterService.markUnhealthy).toHaveBeenCalledWith("c1");
  });

  it("remet un cluster en service après plusieurs vérifications positives consécutives", async () => {
    mockClusterService.list.mockResolvedValue([cluster({ status: "failed" })]);
    mockForCluster.mockResolvedValue({
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 1, reachable: 1, quorumOk: true }),
    });

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockClusterService.markRecovered).toHaveBeenCalledTimes(1);
    expect(mockClusterService.markRecovered).toHaveBeenCalledWith("c1");
  });

  it("ne remet pas un cluster en service après une seule vérification positive, en dessous du seuil", async () => {
    mockClusterService.list.mockResolvedValue([cluster({ status: "failed" })]);
    mockForCluster.mockResolvedValue({
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 1, reachable: 1, quorumOk: true }),
    });

    await runClusterHealthCheck();

    expect(mockClusterService.markRecovered).not.toHaveBeenCalled();
  });

  it("remet le compteur de récupération à zéro si une vérification échoue de nouveau entre-temps", async () => {
    mockClusterService.list.mockResolvedValue([cluster({ status: "failed" })]);
    const healthy = {
      isSwarmActive: vi.fn().mockResolvedValue(true),
      managerHealth: vi
        .fn()
        .mockResolvedValue({ total: 1, reachable: 1, quorumOk: true }),
    };
    mockForCluster.mockResolvedValueOnce(healthy);
    mockForCluster.mockResolvedValueOnce(healthy);
    mockForCluster.mockRejectedValueOnce(new Error("injoignable"));
    mockForCluster.mockResolvedValueOnce(healthy);
    mockForCluster.mockResolvedValueOnce(healthy);

    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();
    await runClusterHealthCheck();

    expect(mockClusterService.markRecovered).not.toHaveBeenCalled();
  });
});
