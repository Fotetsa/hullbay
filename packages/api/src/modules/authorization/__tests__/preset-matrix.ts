import { RESOURCE_CATALOG } from "../catalog/resource-catalog";

// Données de test uniquement (le moteur ne les lit jamais).
export const VIEWER_KEYS = ["project.read", "logs.read"];
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
];
// Owner = tout le catalogue (50).
export const OWNER_KEYS = [...RESOURCE_CATALOG.keys()];
