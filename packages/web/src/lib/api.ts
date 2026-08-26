import type { Project, ProjectGraph, NodeType, Node, DatabaseConfig } from "@hullbay/shared";

/**
 * base64 UTF-8-safe d'un brouillon de config (query GET). `btoa` brut jette une
 * DOMException sur les caractères non-Latin1 (emoji/CJK dans les noms) — on passe
 * par TextEncoder pour encoder la string en UTF-8 avant le base64.
 */
function draftToBase64(draft: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Client API de l'ops-panel. Le token JWT est conservé en localStorage et envoyé
 * en Bearer. En dev, Vite proxie /api vers le back (cf. vite.config.ts).
 */

const TOKEN_KEY = "hullbay_token";

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

export type ApiError = Error & {
  status?: number
  code?: string
  details?: unknown
}

function createApiError(message: string, status: number, code?: string, details?: unknown): ApiError {
  const error = new Error(message) as ApiError
  error.status = status
  if (code) error.code = code
  if (details !== undefined) error.details = details
  return error
}

/**
 * Construit un message d'erreur lisible depuis le corps d'une réponse non-OK.
 * Le backend renvoie `error` soit comme string, soit comme objet Zod `flatten()`
 * ({ formErrors: string[], fieldErrors: Record<string, string[]> }). Sans ce
 * traitement, un `.toString()` naïf affiche "[object Object]".
 */
function extractError(body: unknown, status: number): string {
  const err = (body as { error?: unknown })?.error;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const zod = err as {
      formErrors?: string[];
      fieldErrors?: Record<string, string[]>;
    };
    const parts: string[] = [];
    if (Array.isArray(zod.formErrors)) parts.push(...zod.formErrors);
    if (zod.fieldErrors) {
      for (const [field, msgs] of Object.entries(zod.fieldErrors)) {
        if (Array.isArray(msgs) && msgs.length)
          parts.push(`${field}: ${msgs.join(", ")}`);
      }
    }
    if (parts.length) return parts.join(" · ");
  }
  return `HTTP ${status}`;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  // N'envoyer `content-type: application/json` QUE s'il y a réellement un corps.
  // Sinon Fastify, voyant ce header sur une requête sans body (ex. DELETE), rejette
  // avec FST_ERR_CTP_EMPTY_JSON_BODY (400). C'était la cause des "bad request".
  if (init.body != null) headers["content-type"] = "application/json";
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = extractError(body, res.status)
    const code =
      body && typeof body === "object" && body !== null && typeof (body as any).code === "string"
        ? (body as any).code
        : undefined
    const error = createApiError(message, res.status, code, body)

    // 401 avec un token présent = session expirée/invalide. On purge le token et on
    // renvoie au login (sinon React Query boucle indéfiniment sur des 401). On exclut
    // les routes d'auth pour ne pas casser le flux de connexion lui-même.
    if (res.status === 401 && auth.token && !path.includes("/api/auth/")) {
      auth.clear();
      if (
        typeof window !== "undefined" &&
        window.location.pathname !== "/login"
      ) {
        window.location.assign("/login");
      }

      throw createApiError("Session expirée. Reconnecte-toi.", res.status, code, body);
    }
    throw error

  }
  // 204 / corps vide : pas de JSON à parser.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  // Onboarding / Auth
  needsBootstrap: () =>
    req<{ needsBootstrap: boolean }>("/api/auth/needs-bootstrap"),
  bootstrap: (email: string, password: string) =>
    req<{ ok: boolean; id: string }>("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    req<{ mfaRequired: boolean; token?: string; pendingToken?: string }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),
  verifyMfa: (pendingToken: string, code: string) =>
    req<{ token: string }>("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ pendingToken, code }),
    }),
  me: () =>
    req<{ id: string; email: string; role: string; mfaEnabled: boolean }>(
      "/api/auth/me",
    ),
  enrollMfa: () =>
    req<{ otpauth: string; secret: string }>("/api/auth/mfa/enroll", {
      method: "POST",
    }),
  confirmMfa: (code: string) =>
    req<{ ok: boolean; token: string }>("/api/auth/mfa/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Utilisateurs (owner uniquement)
  listUsers: () => req<UserAccount[]>("/api/users"),
  createUser: (data: {
    email: string;
    password: string;
    role: "operator" | "viewer";
  }) =>
    req<{ id: string; email: string; role: string }>("/api/users", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  setUserRole: (id: string, role: "owner" | "operator" | "viewer") =>
    req<{ id: string; email: string; role: string }>(`/api/users/${id}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  deleteUser: (id: string) =>
    req<{ ok: true }>(`/api/users/${id}`, { method: "DELETE" }),

  // Journal d'audit (operator+)
  audit: (
    params: { limit?: number; offset?: number; action?: string } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.action) q.set("action", params.action);
    const qs = q.toString();
    return req<AuditPage>(`/api/audit${qs ? `?${qs}` : ""}`);
  },

  // Projects
  listProjects: () => req<Project[]>("/api/projects"),
  getProject: (id: string) => req<ProjectGraph>(`/api/projects/${id}`),
  createProject: (data: {
    name: string;
    description?: string;
    clusterId: string;
  }) =>
    req<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateProject: (id: string, data: { name?: string; description?: string }) =>
    req<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteProject: (id: string) =>
    req<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),

  // Nodes
  createNode: (
    projectId: string,
    data: {
      type: NodeType;
      name: string;
      posX: number;
      posY: number;
      config: Record<string, unknown>;
    },
  ) =>
    req<Node>(`/api/projects/${projectId}/nodes`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateNode: (
    nodeId: string,
    data: Partial<{
      name: string;
      posX: number;
      posY: number;
      config: Record<string, unknown>;
    }>,
  ) =>
    req(`/api/nodes/${nodeId}`, { method: "POST", body: JSON.stringify(data) }),
  deleteNode: (nodeId: string) =>
    req(`/api/nodes/${nodeId}`, { method: "DELETE" }),

  // Edges
  createEdge: (
    projectId: string,
    data: { sourceNodeId: string; targetNodeId: string; kind?: string },
  ) =>
    req(`/api/projects/${projectId}/edges`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateEdge: (
    edgeId: string,
    data: { config: Record<string, unknown> | null },
  ) =>
    req(`/api/edges/${edgeId}`, { method: "POST", body: JSON.stringify(data) }),
  deleteEdge: (edgeId: string) =>
    req(`/api/edges/${edgeId}`, { method: "DELETE" }),

  // Moteur
  plan: (id: string) => req<ReconcilePlan>(`/api/projects/${id}/plan`),
  /** Aperçu lecture seule des ressources générées d'un nœud database (S5-09/10).
   *  `draft` : config EN COURS d'édition (non sauvée) — prévisualise avant save. */
  databaseNodePreview: (
    projectId: string,
    nodeId: string,
    draft?: Partial<DatabaseConfig>,
  ) =>
    req<DatabaseNodePreview>(
      `/api/projects/${projectId}/nodes/${nodeId}/preview` +
        (draft ? `?draft=${encodeURIComponent(draftToBase64(draft))}` : ""),
    ),
  deploy: (id: string) =>
    req<{ ok: boolean; log: string[] }>(`/api/projects/${id}/deploy`, {
      method: "POST",
    }),
  destroy: (id: string) =>
    req<{ ok: boolean; log: string[] }>(`/api/projects/${id}/destroy`, {
      method: "POST",
    }),
  rebuild: () =>
    req<{ ok: boolean; projects: number; nodes: number; edges: number }>(
      "/api/rebuild-from-docker",
      { method: "POST" },
    ),

  // Clusters
  listClusters: () => req<Cluster[]>("/api/clusters"),
  deleteCluster: (id: string, opts: { teardown?: boolean } = {}) =>
    req<{ ok: true; removedServers: number; status: "deleted" | "deleting" }>(
      `/api/clusters/${id}${opts.teardown ? "?teardown=true" : ""}`,
      { method: "DELETE" },
    ),

  // Serveurs (cluster Swarm)
  listServers: () =>
    req<{ servers: Server[]; swarmNodes: number; managers: ManagerHealth }>(
      "/api/servers",
    ),
  provisionServer: (data: {
    name: string;
    host: string;
    port: number;
    user: string;
    role?: "manager" | "worker";
    clusterId?: string;
    newClusterName?: string;
    credential:
      | { type: "key"; privateKey: string; passphrase?: string }
      | { type: "password"; password: string };
  }) =>
    req<{ id: string; role: string; status: string }>("/api/servers", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteServer: (id: string) =>
    req<{ ok: true }>(`/api/servers/${id}`, { method: "DELETE" }),
  setServerRole: (id: string, role: "manager" | "worker") =>
    req<{ ok: true; role: string }>(`/api/servers/${id}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),

  // Registre
  listRegistry: () =>
    req<{ id: string; registry: string; username: string }[]>("/api/registry"),
  setRegistry: (data: { registry: string; username: string; token: string }) =>
    req("/api/registry", { method: "POST", body: JSON.stringify(data) }),
  deleteRegistry: (id: string) =>
    req<{ ok: true }>(`/api/registry/${id}`, { method: "DELETE" }),

  // Observabilité
  clusterHealth: () =>
    req<{ clusters: ClusterHealth[] }>("/api/health/cluster"),
  serviceMetrics: (serviceId: string) =>
    req<ServiceHealth>(
      `/api/services/${encodeURIComponent(serviceId)}/metrics`,
    ),
  drift: () => req<{ drift: DriftEntry[] }>("/api/drift"),
  projectPlacement: (id: string) =>
    req<{ servers: string[] }>(`/api/projects/${id}/placement`),
  prunePreview: () => req<PruneResult>("/api/prune"),
  pruneApply: () => req<PruneResult>("/api/prune", { method: "POST" }),

  // Secrets (Docker Secrets — valeurs write-only, jamais relues)
  listSecrets: (clusterId: string) =>
    req<{ id: string; name: string }[]>(`/api/clusters/${clusterId}/secrets`),
  setSecret: (clusterId: string, data: { name: string; value: string }) =>
    req<{ ok: true; name: string }>(`/api/clusters/${clusterId}/secrets`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteSecret: (clusterId: string, name: string) =>
    req<{ ok: true }>(
      `/api/clusters/${clusterId}/secrets/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      },
    ),

  // Domaine
  getDomain: () => req<{ domain: string }>("/api/settings/domain"),
  setDomain: (domain: string) =>
    req<{ ok: boolean; url?: string }>("/api/settings/domain", {
      method: "POST",
      body: JSON.stringify({ domain }),
    }),

  // Mises à jour de l'instance (owner uniquement)
  updatesCheck: (params: { channel?: UpdateChannel | "all" } = {}) => {
    const qs = params.channel ? `?channel=${params.channel}` : "";
    return req<UpdatesCheck>(`/api/updates/check${qs}`);
  },
  updatesHistory: (params: UpdateHistoryParams = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.status) q.set("status", params.status);
    const qs = q.toString();
    return req<UpdateHistoryResult>(
      `/api/updates/history${qs ? `?${qs}` : ""}`,
    );
  },
  updatesStatus: (id: string) =>
    req<SystemUpdateRecord>(`/api/updates/status/${id}`),
  setUpdateChannel: (channel: UpdateChannel) =>
    req<{ ok: true; channel: UpdateChannel }>("/api/updates/channel", {
      method: "PUT",
      body: JSON.stringify({ channel }),
    }),
  applyUpdate: (opts: { channel?: UpdateChannel; version?: string }) =>
    req<{ id: string; status: "running" }>("/api/updates/apply", {
      method: "POST",
      body: JSON.stringify(opts),
    }),
  rollbackUpdate: (id: string) =>
    req<{ id: string; status: "running" }>(`/api/updates/${id}/rollback`, {
      method: "POST",
    }),
};

// ── Types ──────────────────────────────────────────────────────────────────

export type Cluster = {
  id: string;
  name: string;
  isDefault: boolean;
  status: "pending" | "ready" | "failed" | "deleting";
};

export type UserAccount = {
  id: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  createdAt: string;
};

export type AuditEntry = {
  id: string;
  action: string;
  userEmail: string | null;
  projectId: string | null;
  serverId: string | null;
  nodeId: string | null;
  ip: string | null;
  payload: unknown;
  createdAt: string;
};

export type AuditPage = {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntry[];
};

export type DiffAction =
  | { kind: "create"; node: { id: string; name: string; type: string } }
  | {
      kind: "update";
      node: { id: string; name: string; type: string };
      existingId: string;
    }
  | {
      kind: "noop";
      node: { id: string; name: string; type: string };
      existingId: string;
    }
  | { kind: "remove"; dockerId: string; name: string; type: string };

export type ReconcilePlan = { actions: DiffAction[] };

/** Aperçu des ressources générées d'un nœud database (S5-09/10). */
export type DatabaseNodePreview = {
  resources: { name: string; kind: "container" | "network" | "volume"; role: string }[];
  connections: {
    role: "writer" | "reader";
    host: string;
    port: number;
    database: string;
    username: string;
    passwordSecretRef: string;
  }[];
  missingPasswordSecret?: boolean;
};

export type NodeHealth = {
  clusterId: string;
  swarmNodeId: string;
  hostname: string;
  role: string;
  state: string;
  availability: string;
  leader: boolean;
};

export type ServicePlacement = {
  nodeId: string;
  hostname: string;
  state: string;
  desiredState: string;
  error?: string;
};

export type ServiceHealth = {
  clusterId: string;
  serviceId: string;
  name: string;
  desiredReplicas: number;
  runningReplicas: number;
  sampledTasks: number;
  avgCpuPct: number;
  totalMemBytes: number;
  projectId?: string;
  nodeId?: string;
  placements: ServicePlacement[];
};

export type ClusterHealth = {
  clusterId: string;
  clusterName: string;
  swarmActive: boolean;
  nodes: NodeHealth[];
  services: ServiceHealth[];
};

export type DriftEntry = {
  projectId: string;
  count: number;
  actions: string[];
  at: number;
};

export type PruneCandidate = {
  kind: "service" | "network" | "volume";
  id: string;
  name: string;
  projectId?: string;
  reason: string;
};

export type PruneResult = {
  applied: boolean;
  candidates: PruneCandidate[];
  removed: PruneCandidate[];
  errors: { id: string; error: string }[];
};

export type ManagerHealth = {
  total: number;
  reachable: number;
  quorumOk: boolean;
};

export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  role: string;
  status: string;
  swarmNodeId: string | null;
  lastError: string | null;
  clusterId: string;
};

export type UpdateChannel = "stable" | "beta";

export type UpdateRelease = {
  version: string;
  tag: string;
  prerelease: boolean;
  publishedAt: string | null;
  url: string;
  notes: string;
};

export type ChannelEntry = {
  at: string;
  from: UpdateChannel;
  to: UpdateChannel;
};

export type UpdatesCheck = {
  currentVersion: string;
  updateChannel: UpdateChannel;
  updateAvailable: boolean;
  latestVersion: string | null;
  latest: UpdateRelease | null;
  releases: UpdateRelease[];
  lastCheckAt: string;
  degraded?: string | null;
  channelHistory: ChannelEntry[];
};

export type UpdateStepRec = {
  name: string;
  status: "pending" | "running" | "success" | "failed";
  error?: string;
};

export type UpdateHistoryResult = {
  items: SystemUpdateRecord[];
  total: number;
  hasMore: boolean;
};

export type UpdateHistoryParams = {
  limit?: number;
  offset?: number;
  status?: SystemUpdateRecord["status"];
};

export type SystemUpdateRecord = {
  id: string;
  status: string;
  fromVersion: string | null;
  toVersion: string | null;
  channel: UpdateChannel;
  steps: UpdateStepRec[];
  logs: string[];
  error: string | null;
  rolledBack: boolean;
  rollbackOfId: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};
