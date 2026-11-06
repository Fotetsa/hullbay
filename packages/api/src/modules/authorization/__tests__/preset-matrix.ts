import { RESOURCE_CATALOG } from "../catalog/resource-catalog";

export const VIEWER_KEYS = [
  "project.read",
  "logs.read",
  "backup.policy.read",
  "backup.artifact.read",
];
export const OPERATOR_KEYS = [
  ...VIEWER_KEYS,
  "project.create",
  "project.update",
  "project.delete",
  "project.deploy",
  "project.destroy",
  "project.rebuild",
  "graph.node.create",
  "graph.node.update",
  "graph.node.delete",
  "graph.edge.create",
  "graph.edge.update",
  "graph.edge.delete",
  "secret.read",
  "secret.set",
  "secret.delete",
  "prune.dry",
  "audit.read",
  "backup.policy.create",
  "backup.policy.update",
  "backup.policy.delete",
  "backup.run",
];
export const OWNER_KEYS = [...RESOURCE_CATALOG.keys()];
