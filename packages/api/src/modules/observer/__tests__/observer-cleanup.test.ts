import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startObserver, stopObserver } from "../service";
import { prisma } from "../../../lib/prisma";
import { getDockerForCluster } from "../../docker-engine/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: { cluster: { findMany: vi.fn() }, node: { update: vi.fn() } },
}));
vi.mock("../../docker-engine/client", () => ({ getDockerForCluster: vi.fn() }));
vi.mock("../../docker-engine/service", () => ({
  DockerEngineService: {
    forCluster: vi.fn(async () => ({
      listManagedContainers: vi.fn(async () => []),
    })),
  },
}));

describe("observer cleanup (#82)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    stopObserver();
    vi.useRealTimers();
  });

  it("ne laisse aucun timer actif après stopObserver(), même en cas d'échec de connexion", async () => {
    vi.mocked(prisma.cluster.findMany).mockResolvedValue([
      { id: "c1" },
      { id: "c2" },
    ] as any);
    vi.mocked(getDockerForCluster).mockResolvedValue({
      getEvents: (_opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("connexion refusée")),
    } as any);

    await startObserver();
    await vi.advanceTimersByTimeAsync(0); // laisse les promesses en attente se résoudre

    stopObserver();

    expect(vi.getTimerCount()).toBe(0);
  });
});
