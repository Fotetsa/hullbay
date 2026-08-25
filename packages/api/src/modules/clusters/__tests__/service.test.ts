import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClusterService } from "../service";
import { Prisma } from "@prisma/client";

const { mockTx, mockPrisma, mockEventBus } = vi.hoisted(() => {
  const mockTx = {
    server: { deleteMany: vi.fn() },
    cluster: { delete: vi.fn(), create: vi.fn() },
  };
  const mockPrisma = {
    cluster: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    server: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((fn: (tx: typeof mockTx) => unknown) => fn(mockTx)),
  };
  const mockEventBus = { emit: vi.fn() };
  return { mockTx, mockPrisma, mockEventBus };
});

vi.mock("../../../lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("../../../lib/event-bus", () => ({ eventBus: mockEventBus }));

describe("ClusterService.remove", () => {
  let service: ClusterService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ClusterService();
  });

  it("supprime immédiatement (synchrone) si aucun serveur n'est rattaché", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "c1",
      status: "failed",
      isDefault: false,
    });
    mockPrisma.server.findMany.mockResolvedValue([]);
    mockPrisma.cluster.delete.mockResolvedValue({});

    const result = await service.remove("c1");

    expect(result).toEqual({ removedServers: 0, status: "deleted" });
    expect(mockPrisma.cluster.delete).toHaveBeenCalledWith({
      where: { id: "c1" },
    });
    expect(mockPrisma.cluster.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it("refuse (409) si des serveurs existent et teardown n'est pas demandé", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "c1",
      status: "failed",
      isDefault: false,
    });
    mockPrisma.server.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);

    await expect(service.remove("c1")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mockPrisma.cluster.delete).not.toHaveBeenCalled();
  });

  it("passe en 'deleting' et émet cluster.delete.requested si teardown=true", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "c1",
      status: "failed",
      isDefault: false,
    });
    mockPrisma.server.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    mockPrisma.cluster.update.mockResolvedValue({});

    const result = await service.remove("c1", { teardown: true });

    expect(result).toEqual({ removedServers: 2, status: "deleting" });
    expect(mockPrisma.cluster.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "deleting" },
    });
    expect(mockEventBus.emit).toHaveBeenCalledWith("cluster.delete.requested", {
      clusterId: "c1",
      serverIds: ["s1", "s2"],
    });
    expect(mockPrisma.cluster.delete).not.toHaveBeenCalled();
  });

  it("refuse (409) de supprimer un cluster ready", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "c1",
      status: "ready",
      isDefault: false,
    });

    await expect(service.remove("c1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("opérationnel"),
    });
    expect(mockPrisma.server.findMany).not.toHaveBeenCalled();
  });

  it("refuse (403) de supprimer le cluster par défaut, même si son statut n'est pas ready", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "default-cluster",
      status: "pending",
      isDefault: true,
    });

    await expect(service.remove("default-cluster")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockPrisma.server.findMany).not.toHaveBeenCalled();
  });

  it("refuse (409) si une suppression est déjà en cours", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "c1",
      status: "deleting",
      isDefault: false,
    });

    await expect(service.remove("c1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("déjà en cours"),
    });
  });

  it("404 si le cluster n'existe pas", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue(null);
    await expect(service.remove("inconnu")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("ClusterService.createPending", () => {
  let service: ClusterService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ClusterService();
  });

  it("remplace un cluster FAILED portant le même nom, sans erreur P2002", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "old-failed-cluster",
      name: "Cluster Test",
      status: "failed",
    });
    mockTx.server.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.cluster.delete.mockResolvedValue({});
    mockTx.cluster.create.mockResolvedValue({
      id: "new-cluster",
      name: "Cluster Test",
      status: "pending",
    });

    const result = await service.createPending("Cluster Test");

    expect(mockTx.cluster.delete).toHaveBeenCalledWith({
      where: { id: "old-failed-cluster" },
    });
    expect(result.status).toBe("pending");
  });

  it("refuse (409) si un cluster READY porte déjà ce nom", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue({
      id: "existing",
      name: "Cluster Prod",
      status: "ready",
    });

    await expect(service.createPending("Cluster Prod")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("crée normalement si aucun cluster ne porte ce nom", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue(null);
    mockPrisma.cluster.create.mockResolvedValue({
      id: "c1",
      name: "Nouveau",
      status: "pending",
    });

    const result = await service.createPending("Nouveau");

    expect(result.status).toBe("pending");
    expect(mockTx.server.deleteMany).not.toHaveBeenCalled();
  });

  it("course concurrente sur le même nom → la 2e requête reçoit un 409 lisible, pas un 500", async () => {
    mockPrisma.cluster.findUnique.mockResolvedValue(null);

    mockPrisma.cluster.create
      .mockResolvedValueOnce({
        id: "c1",
        name: "Cluster Course",
        status: "pending",
      })
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`name`)",
          { code: "P2002", clientVersion: "5.22.0" },
        ),
      );

    const [a, b] = await Promise.allSettled([
      service.createPending("Cluster Course"),
      service.createPending("Cluster Course"),
    ]);

    const succeeded = [a, b].filter((r) => r.status === "fulfilled");
    const failed = [a, b].filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
    });
  });
});
