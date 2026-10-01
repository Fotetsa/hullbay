import type { Project, ProjectGraph, NodeType, Node, DatabaseConfig } from "@hullbay/shared";
import i18n from "../i18n/config";

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
  /** Secondes avant une nouvelle tentative possible (réponse 429). */
  retryAfterSec?: number
}

function createApiError(message: string, status: number, code?: string, details?: unknown): ApiError {
  const error = new Error(message) as ApiError
  error.status = status
  if (code) error.code = code
  if (details !== undefined) error.details = details
  return error
}

/**
 * Traduit un code d'erreur backend stable via la table `apiErrors.*` des locales.
 * Renvoie null si le code est absent ou non traduit (le message backend sert
 * alors de repli). Les messages backend sont en français (langue produit) ; la
 * traduction par code permet une UI bilingue sans coupler le front aux libellés.
 */
function translateApiCode(code: unknown): string | null {
  if (typeof code !== "string" || !code) return null;
  const key = `apiErrors.${code}`;
  return i18n.exists(key) ? i18n.t(key) : null;
}

/**
 * Construit un message d'erreur lisible depuis le corps d'une réponse non-OK.
 * Le backend renvoie `error` soit comme string, soit comme objet Zod `flatten()`
 * ({ formErrors: string[], fieldErrors: Record<string, string[]> }). Sans ce
 * traitement, un `.toString()` naïf affiche "[object Object]".
 */
function extractError(body: unknown, status: number): string {
  const fromCode = translateApiCode((body as { code?: unknown })?.code);
  if (fromCode) return fromCode;
  const err = (body as { error?: unknown })?.error;
  if (typeof err === "string" && err.trim()) {
    return translateApiCode(err) ?? err;
  }
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
  const msg = (body as { message?: unknown })?.message;
  if (typeof msg === "string" && msg.trim()) return msg;
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

    // 429 = rate limit : le back indique le délai avant réessai (Retry-After).
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retry) && retry > 0) error.retryAfterSec = retry;
    }

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

function normalizeEnvironment(value: unknown): Environment {
  const v = typeof value === "string" ? value.toLocaleLowerCase().trim() : "";
  if (v === "development" || v === "test") return v;
  return "production";
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
  listAuthProviders: () =>
    req<AuthProviderPublic[]>("/api/auth/providers"),
  me: () =>
    req<Me>("/api/auth/me"),
  switchTenant: (tenantId: string) =>
    req<{ token: string; activeTenantId: string }>("/api/auth/session/switch-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId }),
    }),
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
  listSessions: () =>
    req<{ sessions: { id: string; jti: string; providerId: string; createdAt: string; expiresAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }[] }>("/api/auth/sessions"),
  revokeSession: (jti: string) =>
    req<void>(`/api/auth/sessions/${jti}`, { method: "DELETE" }),
  ldapLogin: (providerId: string, username: string, password: string) =>
    req<{ mfaRequired: boolean; token?: string; pendingToken?: string }>(
      `/api/auth/ldap/${encodeURIComponent(providerId)}/login`,
      { method: "POST", body: JSON.stringify({ username, password }) },
    ),
  getWebauthnRegisterOptions: () =>
    req<any>("/api/auth/mfa/webauthn/register/options", { method: "POST" }),
  verifyWebauthnRegister: (response: any, name?: string) =>
    req<{ verified: boolean; credentialId: string }>("/api/auth/mfa/webauthn/register/verify", {
      method: "POST",
      body: JSON.stringify({ response, name }),
    }),
  getWebauthnAuthOptions: (pendingToken?: string) =>
    req<any>("/api/auth/mfa/webauthn/auth/options", {
      method: "POST",
      body: JSON.stringify({ pendingToken }),
    }),
  verifyWebauthnAuth: (pendingToken: string | undefined, response: any) =>
    req<{ ok: boolean; token: string }>("/api/auth/mfa/webauthn/auth/verify", {
      method: "POST",
      body: JSON.stringify({ pendingToken, response }),
    }),
  listWebauthnCredentials: () =>
    req<WebauthnCredentialPublic[]>("/api/auth/mfa/webauthn/credentials"),
  deleteWebauthnCredential: (id: string) =>
    req<void>(`/api/auth/mfa/webauthn/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),

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

  // Providers d'authentification + approbations (owner uniquement).
  listAdminProviders: () => req<AuthProviderAdmin[]>("/api/auth/admin/providers"),
  createAdminProvider: (data: AuthProviderUpsert) =>
    req<AuthProviderAdmin>("/api/auth/admin/providers", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAdminProvider: (id: string, data: Partial<Omit<AuthProviderUpsert, "kind" | "id">>) =>
    req<AuthProviderAdmin>(`/api/auth/admin/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAdminProvider: (id: string) =>
    req<{ ok: true }>(`/api/auth/admin/providers/${id}`, { method: "DELETE" }),
  testAdminProvider: (id: string) =>
    req<ProviderTestResult>(`/api/auth/admin/providers/${id}/test`, {
      method: "POST",
    }),
  // Prévol (wizard) : valide + sonde une config SANS la persister.
  preflightAdminProvider: (kind: string, config: Record<string, unknown>) =>
    req<AuthProviderPreflightResult>("/api/auth/admin/providers/preflight", {
      method: "POST",
      body: JSON.stringify({ kind, config }),
    }),
  listAdminPendings: () => req<PendingIdentity[]>("/api/auth/admin/pendings"),
  approveAdminPending: (id: string, target: ApproveTarget) =>
    req<{ ok: boolean; message: string }>(`/api/auth/admin/pendings/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(target),
    }),
  rejectAdminPending: (id: string, reason?: string) =>
    req<{ ok: boolean; message: string }>(`/api/auth/admin/pendings/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  listTenants: () =>
    req<Tenant[]>("/api/auth/admin/tenants"),

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

  // WebAuthn / Passkeys — config RP du tenant (owner), stockée en base
  getSettingsWebauthn: () =>
    req<{ enabled: boolean; origin: string | null; rpId: string | null; rpName: string }>(
      "/api/settings/webauthn",
    ),
  setSettingsWebauthn: (input: {
    enabled: boolean
    origin?: string
    rpId?: string
    rpName?: string
  }) =>
    req<{ enabled: boolean; origin: string | null; rpId: string | null; rpName: string }>(
      "/api/settings/webauthn",
      { method: "POST", body: JSON.stringify(input) },
    ),

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

  // Système
  getEnvironment: () =>
    req<{ environment: unknown }>("/api/system/environment").then((r) => ({
      environment: normalizeEnvironment(r.environment),
    })),
};

// ── Types ──────────────────────────────────────────────────────────────────

export type Environment = "development" | "test" | "production";

/** Tenants accessibles au compte (membreships) ; alimente le switcher. */
export type MemberTenant = {
  tenantId: string;
  role: "owner" | "operator" | "viewer";
  tenant: { slug: string };
};

/** Profil exposé par GET /api/auth/me : le rôle suit le tenant actif de session. */
export type Me = {
  id: string;
  email: string;
  role: "owner" | "operator" | "viewer";
  mfaEnabled: boolean;
  mfaRequired?: boolean;
  activeTenantId?: string;
  tenants?: MemberTenant[];
};

export type AuthProviderPublic = {
  id: string;
  kind: "oidc" | "oauth2" | "saml" | "ldap" | "local";
  name: string;
  enabled: boolean;
};

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

export type WebauthnCredentialPublic = {
  id: string;
  credentialId: string;
  name: string | null;
  deviceType: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

/** Provider vu de l'admin (owner) : config en clair SAUF champs sensibles,
 *  masqués par marqueur par le backend (jamais la valeur du secret). */
export type AuthProviderAdmin = {
  id: string;
  kind: "oidc" | "oauth2" | "saml" | "ldap" | "local";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

/** Marqueur de présence côté API : envoyer sur un champ sensible en PUT
 *  signifie "conserver la valeur actuelle" (ne jamais écraser). */
export const SECRET_MASK = "••••••••";

export type AuthProviderUpsert = {
  id?: string;
  kind: "oidc" | "oauth2" | "saml" | "ldap";
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
};

export type ProviderTestResult = {
  ok: boolean;
  message?: string;
  connectivity?: string | null;
  details?: unknown;
};

export type AuthProviderPreflightStep = {
  step: string;
  ok: boolean;
  message: string;
  latencyMs?: number;
};

export type AuthProviderPreflightResult = {
  ok: boolean;
  schemaValid: boolean;
  steps: AuthProviderPreflightStep[];
  details?: Record<string, unknown>;
};

export type PendingIdentity = {
  id: string;
  providerId: string;
  issuer: string | null;
  subject: string;
  email: string | null;
  name: string | null;
  requestedForTenantId: string | null;
  status: string;
  createdAt: string;
};

export type Tenant = {
  id: string;
  name: string;
  slug: string;
};

export type ApproveTarget = {
  tenantId: string;
  role: "owner" | "operator" | "viewer";
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
  memoryBytes: number;
  nanoCpus: number;
  os: string;
  architecture: string;
  dockerVersion: string;
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
  diskUsage: {
    layersSize: number;
    images: number;
    containers: number;
    volumes: number;
  };
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

export type SystemInfoSnapshot = {
  os: string | null;
  kernel: string | null;
  cpuCores: number | null;
  ramTotalMb: number | null;
  ramUsedMb: number | null;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
  diskTotalGb: number | null;
  diskUsedGb: number | null;
  collectedAt: string;
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
  systemInfo: SystemInfoSnapshot | null;
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
