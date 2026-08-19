import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../../lib/prisma";
import { eventBus } from "../../../lib/event-bus";
import { handleContainerEvent, resetTrackerForTests } from "../service";

const mockEngine = {
  findServiceIdByNodeId: vi.fn(),
  getServiceMetrics: vi.fn(),
};

vi.mock("../../../lib/prisma", () => ({
  prisma: { node: { update: vi.fn().mockResolvedValue({}) } },
}));

vi.mock("../../../lib/event-bus", () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../modules/docker-engine/client", () => ({
  getDockerForCluster: vi.fn(() => ({})),
  getDefaultCluster: vi.fn(() => ({ id: "default" })),
}));

vi.mock("../../../modules/docker-engine/service", () => ({
  DockerEngineService: class {
    static forCluster = vi.fn(() => mockEngine);
    findServiceIdByNodeId = vi.fn().mockResolvedValue("svc-1");
    getServiceMetrics = vi.fn().mockResolvedValue({ runningReplicas: 1 });
    listManagedContainers = vi.fn().mockResolvedValue([]);
  },
}));

function containerEvent(dockerId: string, nodeId: string, action: string) {
  return {
    Type: "container",
    Action: action,
    Actor: {
      ID: dockerId,
      Attributes: { "bozando.nodeId": nodeId, "bozando.projectId": "proj-1" },
    },
  };
}

describe("observer.service — handleContainerEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetTrackerForTests();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("ignore les events non-conteneur", async () => {
    await handleContainerEvent(
      { Type: "service", Action: "update" } as never,
      mockEngine as any,
    );
    expect(prisma.node.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("ignore les events sans bozando.nodeId", async () => {
    await handleContainerEvent(
      {
        Type: "container",
        Action: "start",
        Actor: { ID: "c1", Attributes: {} },
      } as any,
      mockEngine as any,
    );
    expect(prisma.node.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("persiste et émet un changement d'état (create -> running)", async () => {
    await handleContainerEvent(
      containerEvent("c1", "n1", "create"),
      mockEngine as any,
    );
    expect(prisma.node.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { actualState: "created" } }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      "node.state",
      expect.objectContaining({ nodeId: "n1", state: "created" }),
    );

    await handleContainerEvent(
      containerEvent("c1", "n1", "start"),
      mockEngine as any,
    );
    expect(prisma.node.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { actualState: "running" } }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      "node.state",
      expect.objectContaining({ nodeId: "n1", state: "running" }),
    );
  });

  it("ne ré-écrit ni ne ré-émet quand l'état résolu ne change pas", async () => {
    await handleContainerEvent(
      containerEvent("c1", "n1", "start"),
      mockEngine as any,
    );
    vi.clearAllMocks();

    await handleContainerEvent(
      containerEvent("c1", "n1", "start"),
      mockEngine as any,
    );
    expect(prisma.node.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("rolling update : la mort de l'ancien conteneur ne fait pas basculer l'état", async () => {
    await handleContainerEvent(
      containerEvent("old", "n1", "create"),
      mockEngine as any,
    );
    await handleContainerEvent(
      containerEvent("old", "n1", "start"),
      mockEngine as any,
    );
    vi.clearAllMocks();

    await handleContainerEvent(
      containerEvent("new", "n1", "create"),
      mockEngine as any,
    );
    await handleContainerEvent(
      containerEvent("new", "n1", "start"),
      mockEngine as any,
    );
    await handleContainerEvent(
      containerEvent("old", "n1", "die"),
      mockEngine as any,
    );
    await handleContainerEvent(
      containerEvent("old", "n1", "destroy"),
      mockEngine as any,
    );

    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(prisma.node.update).not.toHaveBeenCalled();
  });

  it("crash réel : exited est bien propagé quand plus aucun conteneur ne tourne", async () => {
    await handleContainerEvent(
      containerEvent("c1", "n1", "start"),
      mockEngine as any,
    );
    vi.clearAllMocks();

    await handleContainerEvent(
      containerEvent("c1", "n1", "die"),
      mockEngine as any,
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      "node.state",
      expect.objectContaining({ nodeId: "n1", state: "exited" }),
    );
  });
});
