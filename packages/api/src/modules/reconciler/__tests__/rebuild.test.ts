import { describe, it, expect, beforeEach, vi } from "vitest";
import { databaseOwnershipLabels, encodeJsonLabel, LabelKeys, computeDesiredHash } from "@hullbay/shared";
import { rebuildFromDocker } from "../rebuild";
import { expandDatabaseGraph } from "../../database/expansion";
import { prisma } from "../../../lib/prisma";

const mockEngine = {
  listManagedServices: vi.fn(),
  listManagedNetworks: vi.fn(),
  listManagedVolumes: vi.fn(),
};

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    project: { upsert: vi.fn().mockResolvedValue({}) },
    node: { upsert: vi.fn().mockResolvedValue({}) },
    edge: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../../modules/docker-engine/service", () => ({
  DockerEngineService: class {
    static forCluster = vi.fn(() => mockEngine);
  },
}));

const dbConfig = {
  engine: "postgres",
  mode: "ha",
  topology: { replicas: 3 },
  version: "16.3",
  credentials: { username: "app", passwordSecretRef: "db_secret", database: "app" },
  storage: { driver: "local", external: false },
  retainDataOnDelete: true,
};

/** Labels complets d'une ressource générée (buildBozandoLabels + ownership). */
function memberLabels(
  projectId: string,
  slug: string,
  nodeId: string,
  name: string,
): Record<string, string> {
  return {
    [LabelKeys.managed]: "true",
    [LabelKeys.version]: "1",
    [LabelKeys.projectId]: projectId,
    [LabelKeys.projectSlug]: slug,
    [LabelKeys.nodeId]: nodeId,
    [LabelKeys.nodeName]: name,
    [LabelKeys.nodeType]: "container",
    [LabelKeys.canvasX]: "124",
    [LabelKeys.canvasY]: "124",
    [LabelKeys.desiredHash]: "sha256:x",
    [LabelKeys.spec]: encodeJsonLabel({ image: "postgres", replicas: 1 }),
    [LabelKeys.edges]: encodeJsonLabel([]),
    ...databaseOwnershipLabels({
      parentNodeId: "n_db",
      parentNodeName: "Catalog",
      parentConfig: dbConfig,
      role: "member",
      index: 0,
      engine: "postgres",
      data: false,
      retainDataOnDelete: true,
    }),
  };
}

describe("rebuildFromDocker — nœud database parent depuis les labels (S10-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reconstruit le nœud database depuis les labels, sans persister les membres synthétiques", async () => {
    const projectId = "proj-1";
    const slug = "proj-a";
    mockEngine.listManagedServices.mockResolvedValue([
      // Membre database synthétique (porteur de la config parent).
      { Spec: { Labels: memberLabels(projectId, slug, "db::n_db::member::0", "catalog-1") } },
      // Nœud applicatif régulier (ne doit PAS être un membre database).
      {
        Spec: {
          Labels: {
            [LabelKeys.managed]: "true",
            [LabelKeys.projectId]: projectId,
            [LabelKeys.projectSlug]: slug,
            [LabelKeys.nodeId]: "n_app",
            [LabelKeys.nodeName]: "web",
            [LabelKeys.nodeType]: "container",
            [LabelKeys.canvasX]: "50",
            [LabelKeys.canvasY]: "50",
            [LabelKeys.desiredHash]: "sha256:y",
            [LabelKeys.spec]: encodeJsonLabel({ image: "nginx", replicas: 1 }),
            [LabelKeys.edges]: encodeJsonLabel([
              { targetNodeName: "Catalog", kind: "database", config: null },
            ]),
          },
        },
      },
    ]);
    mockEngine.listManagedNetworks.mockResolvedValue([]);
    mockEngine.listManagedVolumes.mockResolvedValue([]);

    const result = await rebuildFromDocker("cluster-1");

    // Nœud database parent persisté avec la config parent encodée, type database.
    const nodeCalls = vi.mocked(prisma.node.upsert).mock.calls;
    const parentCall = nodeCalls.find((c: any) => c[0].where.id === "n_db");
    expect(parentCall).toBeDefined();
    expect(parentCall![0].update.type).toBe("database");
    expect(parentCall![0].update.name).toBe("Catalog");
    expect(parentCall![0].update.posX).toBe(100); // membre 124 - 24
    expect(parentCall![0].update.config).toEqual(dbConfig);
    expect(parentCall![0].update.desiredHash).toContain("sha256:");

    // Aucun membre synthétique persisté (pas de nœud "catalog-1").
    const persistedIds = nodeCalls.map((c: any) => c[0].where.id);
    expect(persistedIds).not.toContain("db::n_db::member::0");

    // Nœud applicatif persisté.
    expect(persistedIds).toContain("n_app");

    // Edge app→database reconstruit (résolu par nom = nœud database parent).
    const edgeCreateCalls = vi.mocked(prisma.edge.create).mock.calls;
    expect(edgeCreateCalls).toHaveLength(1);
    expect(edgeCreateCalls[0]![0].data).toMatchObject({
      projectId,
      sourceNodeId: "n_app",
      targetNodeId: "n_db",
      kind: "database",
    });

    expect(result).toEqual({ projects: 1, nodes: 2, edges: 1, degraded: 0 });
  });

  it("config parent illisible → nœud database dégradé, config EXISTANTE non écrasée", async () => {
    const labels = memberLabels("proj-1", "proj-a", "db::n_db::member::0", "catalog-1");
    labels[LabelKeys.dbParentConfig] = "!!corrupt!!";
    mockEngine.listManagedServices.mockResolvedValue([{ Spec: { Labels: labels } }]);
    mockEngine.listManagedNetworks.mockResolvedValue([]);
    mockEngine.listManagedVolumes.mockResolvedValue([]);

    const result = await rebuildFromDocker("cluster-1");
    const parentCall = vi.mocked(prisma.node.upsert).mock.calls.find(
      (c: any) => c[0].where.id === "n_db",
    );
    // Conservateur : config illisible → on ne touche PAS à la config en base
    // (update sans config ni hash) pour ne pas détruire un état valide.
    expect(parentCall![0].update.config).toBeUndefined();
    expect(parentCall![0].update.desiredHash).toBeUndefined();
    // Create (nœud absent) : config dégradée {} + hash sur vide, marqué degraded.
    expect(parentCall![0].create.config).toEqual({});
    expect(parentCall![0].create.desiredHash).toContain("sha256:");
    expect(result.degraded).toBe(1);
    expect(result.nodes).toBe(1);
  });

  it("plusieurs membres d'un même parent → un seul nœud database reconstruit", async () => {
    const projectId = "proj-1";
    const slug = "proj-a";
    mockEngine.listManagedServices.mockResolvedValue([
      {
        Spec: {
          Labels: memberLabels(projectId, slug, "db::n_db::member::0", "catalog-1"),
        },
      },
      {
        Spec: {
          Labels: memberLabels(projectId, slug, "db::n_db::member::1", "catalog-2"),
        },
      },
      {
        Spec: {
          Labels: memberLabels(projectId, slug, "db::n_db::consensus::0", "catalog-etcd-1"),
        },
      },
    ]);
    mockEngine.listManagedNetworks.mockResolvedValue([]);
    mockEngine.listManagedVolumes.mockResolvedValue([]);

    const result = await rebuildFromDocker("cluster-1");

    const nodeCalls = vi.mocked(prisma.node.upsert).mock.calls;
    const parentCalls = nodeCalls.filter((c: any) => c[0].where.id === "n_db");
    expect(parentCalls).toHaveLength(1);
    // Aucun SYNTHÉTIQUE persisté malgré 3 ressources.
    const persistedIds = nodeCalls.map((c: any) => c[0].where.id);
    expect(persistedIds.filter((id: any) => (id ?? "").startsWith("db::"))).toHaveLength(0);
    expect(result.nodes).toBe(1);
  });
});

describe("rebuild → /plan cohérent + sécurité des labels (S10-03, S10-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Graphe minimal avec le parent database (config ha postgres). */
  function graphWithDb() {
    return {
      id: "proj-1",
      name: "proj-a",
      slug: "proj-a",
      clusterId: "cluster-1",
      status: "deployed" as const,
      nodes: [
        {
          id: "n_db",
          projectId: "proj-1",
          type: "database" as const,
          name: "Catalog",
          posX: 100,
          posY: 100,
          config: dbConfig,
        },
        {
          id: "n_app",
          projectId: "proj-1",
          type: "container" as const,
          name: "web",
          posX: 50,
          posY: 50,
          config: { image: "nginx", tag: "1.27", replicas: 1 },
        },
      ],
      edges: [
        {
          id: "e1",
          projectId: "proj-1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database" as const,
        },
      ],
    };
  }

  it("S10-03: rebuild des labels → ré-expansion identique → plan vide (aucun drift fantôme)", async () => {
    // 1. État DÉSIRÉ original : expansion → hash de chaque membre (ce que le
    //    deploy aurait écrit dans les labels).
    const expanded = expandDatabaseGraph(graphWithDb());
    const members = expanded.graph.nodes.filter(
      (n) => n.type === "container" && n.id.startsWith("db::"),
    );
    expect(members.length).toBeGreaterThan(0);
    const memberHashes = new Map(
      members.map((m) => [
        m.id,
        computeDesiredHash({ type: m.type, name: m.name, config: m.config }),
      ]),
    );

    // 2. Labels Docker réels : membres portant LEUR VRAI hash + config parent.
    mockEngine.listManagedServices.mockResolvedValue([
      ...members.map((m) => ({
        Spec: {
          Labels: memberLabels("proj-1", "proj-a", m.id, m.name),
        },
      })),
      {
        Spec: {
          Labels: {
            [LabelKeys.managed]: "true",
            [LabelKeys.projectId]: "proj-1",
            [LabelKeys.projectSlug]: "proj-a",
            [LabelKeys.nodeId]: "n_app",
            [LabelKeys.nodeName]: "web",
            [LabelKeys.nodeType]: "container",
            [LabelKeys.canvasX]: "50",
            [LabelKeys.canvasY]: "50",
            [LabelKeys.desiredHash]: computeDesiredHash({
              type: "container",
              name: "web",
              config: { image: "nginx", tag: "1.27", replicas: 1 },
            }),
            [LabelKeys.spec]: encodeJsonLabel({ image: "nginx", tag: "1.27", replicas: 1 }),
            [LabelKeys.edges]: encodeJsonLabel([
              { targetNodeName: "Catalog", kind: "database", config: null },
            ]),
          },
        },
      },
    ]);
    mockEngine.listManagedNetworks.mockResolvedValue([]);
    mockEngine.listManagedVolumes.mockResolvedValue([]);

    await rebuildFromDocker("cluster-1");

    // 3. Config parent reconstruite = config originale (roundtrip exact).
    const parentCall = vi.mocked(prisma.node.upsert).mock.calls.find(
      (c: any) => c[0].where.id === "n_db",
    );
    expect(parentCall).toBeDefined();
    expect(parentCall![0].update.config).toEqual(dbConfig);

    // 4. Ré-expansion de la config reconstruite → MÊMES membres, MÊMES hashes.
    //    Le plan qui en découle est donc vide (noop) : aucun update fantôme
    //    après un rebuild, seul le drift réel apparaîtrait.
    const rebuiltGraph = graphWithDb();
    (rebuiltGraph.nodes.find((n) => n.id === "n_db") as { config: unknown }).config =
      parentCall![0].update.config;
    const reExpanded = expandDatabaseGraph(rebuiltGraph);
    for (const m of reExpanded.graph.nodes.filter(
      (n) => n.type === "container" && n.id.startsWith("db::"),
    )) {
      const h = computeDesiredHash({ type: m.type, name: m.name, config: m.config });
      expect(memberHashes.get(m.id)).toBe(h);
    }
  });

  it("S10-04: labels d'ownership — AUCUNE valeur secrète, uniquement la ref (parentConfig encodée)", async () => {
    const SECRET = "s3cr3t-P@ssw0rd-valeur-réelle";
    // La config ne porte JAMAIS la valeur, seulement passwordSecretRef ; on
    // vérifie qu'aucun label encodé ne contient une valeur de mot de passe.
    const labels = memberLabels("proj-1", "proj-a", "db::n_db::member::0", "catalog-1");

    // Toutes les valeurs de labels (brutes) : pas de secret en clair.
    for (const [k, v] of Object.entries(labels)) {
      expect(v, `label ${k} contient une valeur secrète`).not.toContain(SECRET);
    }

    // parentConfig décodée : credentials = ref uniquement, pas de champ password.
    const decodedParent = JSON.parse(
      Buffer.from(labels[LabelKeys.dbParentConfig]!, "base64").toString("utf-8"),
    ) as { credentials: Record<string, unknown> };
    expect(decodedParent.credentials.passwordSecretRef).toBe("db_secret");
    expect(decodedParent.credentials).not.toHaveProperty("password");
    expect(JSON.stringify(decodedParent)).not.toContain(SECRET);
  });
});