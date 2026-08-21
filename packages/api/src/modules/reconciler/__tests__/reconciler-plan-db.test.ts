import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerReconcilerRoutes } from "../routes";
import { registerAuthGuard } from "../../auth/routes";
import { authService } from "../../auth/service";
import { projectsService } from "../../projects/service";
import { LabelKeys, computeDesiredHash, type ProjectGraph } from "@hullbay/shared";
import { expandDatabaseGraph } from "../../database/expansion";

// 0. Auth globale (requise pour toucher /api), token operator.
vi.mock("../../auth/service", () => ({
  authService: { verifyToken: vi.fn() },
}));

// 1. Le graphe persiste : projectsService.getProjectGraph est mocké.
vi.mock("../../projects/service", () => ({
  projectsService: {
    getProjectGraph: vi.fn(),
  },
}));

// 2. Le moteur Docker est un fake (aucun daemon) : deplacer/creer sans réseau.
const fakeEngine = {
  listProjectServices: vi.fn(async () => []),
  listNodes: vi.fn(async () => []),
  listManagedNetworks: vi.fn(async () => []),
  listManagedVolumes: vi.fn(async () => []),
  removeService: vi.fn(),
  removeNetwork: vi.fn(),
  removeVolume: vi.fn(),
  listServiceTasks: vi.fn(async () => []),
  removeVolumeWithRetry: vi.fn(),
  listManagedContainers: vi.fn(async () => []),
  listManagedServices: vi.fn(async () => []),
};
vi.mock("../../../modules/docker-engine/service", () => ({
  DockerEngineService: {
    forCluster: vi.fn(async () => fakeEngine),
  },
}));

const dbNodeConfig = {
  engine: "postgres",
  version: "16.3",
  mode: "single",
  topology: { replicas: 1 },
  storage: { sizeGb: 20 },
  resources: { cpus: 0.5, memMb: 512 },
  credentials: { username: "app", passwordSecretRef: "db_pg_password", database: "app" },
  retainDataOnDelete: true,
};

function dbGraph(): ProjectGraph {
  return {
    id: "p1",
    name: "projet A",
    slug: "proj-a",
    clusterId: "c1",
    status: "draft",
    nodes: [
      {
        id: "n_db",
        projectId: "p1",
        type: "database",
        name: "catalog",
        posX: 100,
        posY: 120,
        config: dbNodeConfig,
      },
      {
        id: "n_app",
        projectId: "p1",
        type: "container",
        name: "web",
        posX: 0,
        posY: 0,
        config: { image: "nginx", tag: "1.27", env: { PORT: "8080" }, replicas: 2 },
      },
    ],
    edges: [
      {
        id: "e1",
        projectId: "p1",
        sourceNodeId: "n_app",
        targetNodeId: "n_db",
        kind: "database",
      },
    ],
  };
}

describe("GET /api/projects/:id/plan — diff étendu (S3-02)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerReconcilerRoutes(app);
      },
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authService.verifyToken).mockImplementation(() => ({
      sub: "op-id",
      role: "operator",
      mfaEnabled: true,
    }));
    vi.mocked(projectsService.getProjectGraph).mockResolvedValue(dbGraph() as never);
  });

  const callPlan = () =>
    app!.inject({
      method: "GET",
      url: "/api/projects/p1/plan",
      headers: { authorization: "Bearer mock-token" },
    });

  it("le diff contient un CREATE pour le MEMBRE généré (pas « rien à faire »)", async () => {
    const res = await callPlan();
    expect(res.statusCode).toBe(200);

    const body = res.json() as { actions: { kind: string; node?: { id: string } }[] };
    const creates = body.actions.filter((a) => a.kind === "create");

    // Membre = conteneur généré (id synthétique db::…) → CREATE.
    expect(creates.map((c) => c.node?.id)).toContain("db::n_db::member::0");
    // L'app de base aussi (aucun service déployé).
    expect(creates.map((c) => c.node?.id)).toContain("n_app");
    expect(body.actions.some((a) => a.kind === "noop")).toBe(false);
  });

  it("le diff ne contient AUCUN nœud de composition database (jamais runtime)", async () => {
    const res = await callPlan();
    const creates = (res.json() as { actions: { kind: string; node?: { id: string } }[] }).actions
      .filter((a) => a.kind === "create")
      .map((a) => a.node?.id);
    expect(creates).not.toContain("n_db");
  });

  it("S10-06: changement de version majeure = UPDATE visible au plan (jamais noop silencieux)", async () => {
    // État déployé = service Swarm portant le hash de l'ANCIENNE config (postgres 16.3).
    const expandedOld = expandDatabaseGraph(dbGraph());
    const memberOld = expandedOld.graph.nodes.find((n) => n.id === "db::n_db::member::0");
    expect(memberOld).toBeDefined();
    const oldHash = computeDesiredHash({
      type: memberOld!.type,
      name: memberOld!.name,
      config: memberOld!.config,
    });
    vi.mocked(fakeEngine.listProjectServices).mockResolvedValue([
      {
        ID: "svc-db-1",
        Spec: {
          Name: "catalog",
          Labels: {
            [LabelKeys.nodeId]: "db::n_db::member::0",
            [LabelKeys.desiredHash]: oldHash,
          },
        },
      },
    ] as never);

    // Le graphe passe en version MAJEURE (16.3 → 17.0) : l'opérateur doit VOIR le changement.
    const major = dbGraph();
    (major.nodes.find((n) => n.id === "n_db") as unknown as { config: { version: string } })
      .config.version = "17.0";

    const res = await callPlan();
    expect(res.statusCode).toBe(200);
    const actions = (res.json() as { actions: { kind: string; node?: { id: string } }[] }).actions;

    const update = actions.find((a) => a.kind === "update" && a.node?.id === "db::n_db::member::0");
    expect(update).toBeDefined();
    expect(actions.some((a) => a.kind === "noop" && a.node?.id === "db::n_db::member::0")).toBe(
      false,
    );
  });
});