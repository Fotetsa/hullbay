import type { ScopeType } from "../scope";

/**
 * Une entrée par permission. Ce fichier décrit la forme des ressources : sur quel
 * type de ressource une action peut viser, quels types de scope peuvent la
 * couvrir, et par quel chemin on retrouve le tenant propriétaire. Il ne dit
 * jamais quel rôle possède quoi : les droits vivent en base.
 *
 * Le scope "tenant" est toujours accepté par le moteur, c'est le périmètre global
 * d'un tenant et les presets s'en servent pour toutes leurs permissions. La
 * liste "scopes" indique donc les périmètres plus étroits acceptés en plus.
 */
export type CatalogEntry = {
  /** Types de ressource que l'appelant peut passer. Vide : action de niveau tenant. */
  resourceTypes: ScopeType[];
  /** Types de scope acceptés pour cette permission (couverture descendante comprise). */
  scopes: ScopeType[];
  /** Chemin documentaire vers le tenant propriétaire, résolu par le repository. */
  tenantPath: string;
};

const entry = (
  resourceTypes: ScopeType[],
  scopes: ScopeType[],
  tenantPath: string,
): CatalogEntry => ({
  resourceTypes,
  scopes,
  tenantPath,
});

const tenantLevel = entry([], ["tenant"], "contexte de requête");

const RAW: Record<string, CatalogEntry> = {
  "cluster.read": entry(["cluster"], ["tenant", "cluster"], "Cluster.tenantId"),
  "cluster.create": entry([], ["tenant"], "contexte de requête"),
  "cluster.update": entry(["cluster"], ["cluster"], "Cluster.tenantId"),
  "cluster.delete": entry(["cluster"], ["cluster"], "Cluster.tenantId"),

  "server.read": entry(
    ["server", "cluster"],
    ["cluster", "server"],
    "Server.tenantId",
  ),
  "server.create": entry(["cluster"], ["cluster"], "Cluster.tenantId"),
  "server.delete": entry(["server"], ["server"], "Server.tenantId"),
  "server.promote": entry(["server"], ["server"], "Server.tenantId"),
  "server.demote": entry(["server"], ["server"], "Server.tenantId"),

  "project.read": entry(
    ["project", "cluster"],
    ["tenant", "cluster", "project"],
    "Project.tenantId",
  ),
  "project.create": entry(
    ["cluster"],
    ["tenant", "cluster"],
    "Cluster.tenantId",
  ),
  "project.update": entry(["project"], ["project"], "Project.tenantId"),
  "project.delete": entry(["project"], ["project"], "Project.tenantId"),
  "project.deploy": entry(
    ["project"],
    ["tenant", "cluster", "project"],
    "Project.tenantId",
  ),
  "project.destroy": entry(["project"], ["project"], "Project.tenantId"),
  "project.rebuild": entry(["project"], ["project"], "Project.tenantId"),

  "graph.node.create": entry(["project"], ["project"], "Project.tenantId"),
  "graph.node.update": entry(["node"], ["node"], "Node.project.tenantId"),
  "graph.node.delete": entry(["node"], ["node"], "Node.project.tenantId"),
  "graph.edge.create": entry(["project"], ["project"], "Project.tenantId"),
  "graph.edge.update": entry(["edge"], ["edge"], "Edge.project.tenantId"),
  "graph.edge.delete": entry(["edge"], ["edge"], "Edge.project.tenantId"),

  "secret.read": entry(["cluster"], ["cluster"], "Cluster.tenantId"),
  "secret.set": entry(["cluster"], ["cluster"], "Cluster.tenantId"),
  "secret.delete": entry(["cluster"], ["cluster"], "Cluster.tenantId"),

  "registry.read": tenantLevel,
  "registry.set": tenantLevel,
  "registry.delete": tenantLevel,

  // Backup Engine. Les destinations sont des credentials de tenant (comme le
  // registry) ; une policy et un artifact appartiennent au projet qui porte le
  // nœud sauvegardé. 
  "backup.destination.read": tenantLevel,
  "backup.destination.set": tenantLevel,
  "backup.destination.delete": tenantLevel,
  "backup.policy.read": entry(
    ["node", "project"],
    ["tenant", "cluster", "project", "node"],
    "Node.project.tenantId",
  ),
  "backup.policy.create": entry(["node"], ["project", "node"], "Node.project.tenantId"),
  "backup.policy.update": entry(["node"], ["node"], "Node.project.tenantId"),
  "backup.policy.delete": entry(["node"], ["node"], "Node.project.tenantId"),
  "backup.run": entry(["node"], ["project", "node"], "Node.project.tenantId"),
  "backup.artifact.read": entry(
    ["node", "project"],
    ["tenant", "cluster", "project", "node"],
    "Node.project.tenantId",
  ),
  "backup.artifact.restore": entry(["node"], ["node"], "Node.project.tenantId"),

  "settings.domain.read": tenantLevel,
  "settings.domain.set": tenantLevel,
  "audit.read": tenantLevel,

  "logs.read": entry(
    ["cluster", "project"],
    ["tenant", "cluster", "project"],
    "Cluster.tenantId ou Project.tenantId",
  ),

  "update.check": tenantLevel,
  "update.apply": tenantLevel,
  "update.rollback": tenantLevel,
  "update.channel": tenantLevel,

  "user.read": tenantLevel,
  "user.create": tenantLevel,
  "user.update": tenantLevel,
  "user.delete": tenantLevel,

  "provider.read": tenantLevel,
  "provider.create": tenantLevel,
  "provider.update": tenantLevel,
  "provider.delete": tenantLevel,
  "provider.test": tenantLevel,

  "pending.read": tenantLevel,
  "pending.approve": tenantLevel,
  "pending.reject": tenantLevel,

  "prune.dry": entry(["cluster"], ["tenant", "cluster"], "Cluster.tenantId"),
  "prune.apply": entry(["cluster"], ["tenant", "cluster"], "Cluster.tenantId"),
};

// Une Map, pas un objet : une clé comme "constructor" ou "__proto__" ne doit jamais
// pouvoir correspondre à une entrée par héritage de prototype.
export const RESOURCE_CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(
  Object.entries(RAW),
);
