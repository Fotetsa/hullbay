import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTx,
  mockPrisma,
  mockEventBus,
  mockGetInternal,
  mockForCluster,
  mockEngine,
} = vi.hoisted(() => {
  const mockEngine = { drainNode: vi.fn(), removeNode: vi.fn() };
  return {
    mockTx: { server: { deleteMany: vi.fn() }, cluster: { delete: vi.fn() } },
    mockPrisma: { $transaction: vi.fn() },
    mockEventBus: { emit: vi.fn() },
    mockGetInternal: vi.fn(),
    mockForCluster: vi.fn(async () => mockEngine),
    mockEngine,
  };
});

vi.mock("../../lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../../lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("../../modules/servers/service", () => ({
  serversService: { getInternal: mockGetInternal },
}));
vi.mock("../../modules/docker-engine/service", () => ({
  DockerEngineService: { forCluster: mockForCluster },
}));

import { teardownClusterWorkflow } from "../teardown-cluster";

describe("teardownClusterWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    );
    mockEngine.drainNode.mockResolvedValue(undefined);
    mockEngine.removeNode.mockResolvedValue(undefined);
  });

  it("drain + remove chaque nœud Swarm, puis  supprime en base et émet cluster.delete.finished", async () => {
    mockGetInternal.mockImplementation((id: string) =>
      Promise.resolve({ id, swarmNodeId: `node-${id}` }),
    );

    await teardownClusterWorkflow("c1", ["s1", "s2"]);

    expect(mockEngine.drainNode).toHaveBeenCalledTimes(2);
    expect(mockEngine.removeNode).toHaveBeenCalledTimes(2);
    expect(mockTx.server.deleteMany).toHaveBeenCalledWith({
      where: { clusterId: "c1" },
    });
    expect(mockTx.cluster.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(mockEventBus.emit).toHaveBeenCalledWith("cluster.delete.finished", {
      clusterId: "c1",
      errors: [],
    });
  });

  it("un nœud injoignable n'empêche pas le teardown des autres ni la suppression finale", async () => {
    mockGetInternal.mockImplementation((id: string) =>
      Promise.resolve({ id, swarmNodeId: `node-${id}` }),
    );
    mockForCluster.mockRejectedValueOnce(new Error("tunnel indisponible"));

    await teardownClusterWorkflow("c1", ["s1", "s2"]);

    // Le premier échoue (erreur capturée), mais la suppression finale a bien lieu.
    expect(mockTx.cluster.delete).toHaveBeenCalled();
    const emitCall = mockEventBus.emit.mock.calls.find(
      (c) => c[0] === "cluster.delete.finished",
    );
    expect(emitCall?.[1].errors).toHaveLength(1);
  });
});
