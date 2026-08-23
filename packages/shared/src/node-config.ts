import { z } from "zod"

/**
 * Configuration par type de nœud du canvas.
 *
 * Ces schémas sont LA source de vérité partagée : le front les utilise pour
 * valider les formulaires d'options des nœuds, le back (reconciler) pour
 * traduire en appels dockerode, et rebuildFromDocker pour décoder bozando.spec.
 *
 * Régle de sécurité (cf. plan) : pas de montage de "/" ni de --privileged.
 * Les secrets ne doivent PAS finir en clair dans les labels Docker — l'env
 * reste géré ici mais sera traité à part côté secrets (V2).
 */

// ── Conteneur ────────────────────────────────────────────────────────────────

export const PortMappingSchema = z.object({
  /** Port exposé dans le conteneur. */
  container: z.number().int().min(1).max(65535),
  /** Port publié sur l'hôte (optionnel : sinon non publié, accessible via réseau Docker). */
  host: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
})
export type PortMapping = z.infer<typeof PortMappingSchema>

export const RestartPolicySchema = z.enum([
  "no",
  "on-failure",
  "always",
  "unless-stopped",
])
export type RestartPolicy = z.infer<typeof RestartPolicySchema>

export const ResourcesSchema = z.object({
  /** Limite mémoire en Mo. */
  memMb: z.number().int().positive().optional(),
  /** Limite CPU (ex: 0.5 = un demi-cœur). */
  cpus: z.number().positive().optional(),
})
export type Resources = z.infer<typeof ResourcesSchema>

export const HealthcheckSchema = z.object({
  /** Commande de test (forme exec : ["CMD", "curl", ...]). */
  test: z.array(z.string()).min(1),
  intervalSec: z.number().int().positive().default(30),
  timeoutSec: z.number().int().positive().default(10),
  retries: z.number().int().positive().default(3),
  startPeriodSec: z.number().int().nonnegative().default(0),
})
export type Healthcheck = z.infer<typeof HealthcheckSchema>

/**
 * Politique d'auto-scaling d'un service. L'auto-scaler lit le CPU moyen des tasks
 * et ajuste les replicas dans [min, max] : >= scaleUpCpuPct → +1, <= scaleDownCpuPct → -1.
 */
export const AutoscaleSchema = z
  .object({
    enabled: z.boolean().default(false),
    minReplicas: z.number().int().min(1).default(1),
    maxReplicas: z.number().int().min(1).default(3),
    /** Seuil CPU moyen (%) au-dessus duquel on scale up. */
    scaleUpCpuPct: z.number().min(1).max(100).default(75),
    /** Seuil CPU moyen (%) en-dessous duquel on scale down. */
    scaleDownCpuPct: z.number().min(0).max(100).default(25),
  })
  .refine((a) => a.maxReplicas >= a.minReplicas, {
    message: "maxReplicas doit être >= minReplicas",
  })
  .refine((a) => a.scaleUpCpuPct > a.scaleDownCpuPct, {
    message: "scaleUpCpuPct doit être > scaleDownCpuPct",
  })
export type Autoscale = z.infer<typeof AutoscaleSchema>

/**
 * Référence à un Docker Secret monté dans le conteneur. La valeur n'est jamais
 * stockée dans la config (donc jamais dans le label bozando.spec) : seulement le
 * nom du secret et le chemin de montage (défaut /run/secrets/<secretName>).
 */
export const SecretRefSchema = z.object({
  /** Nom du Docker Secret (référence). */
  secretName: z.string().min(1),
  /** Chemin de montage dans le conteneur. Défaut : /run/secrets/<secretName>. */
  target: z.string().optional(),
})
export type SecretRef = z.infer<typeof SecretRefSchema>

/**
 * Politique de récupération d'image, calquée sur Kubernetes `imagePullPolicy` :
 *  - Always       : tire toujours le registre (compare le digest). Protège le CI/CD
 *                   (jamais servir un `latest` local périmé). Échoue si le pull échoue.
 *  - IfNotPresent : tire seulement si l'image est absente localement.
 *  - Never        : ne tire jamais ; exige la présence locale (dev / image non poussée).
 * Si non spécifiée, le défaut est DÉRIVÉ du tag (cf. effectivePullPolicy).
 */
export const PullPolicySchema = z.enum(["Always", "IfNotPresent", "Never"])
export type PullPolicy = z.infer<typeof PullPolicySchema>

/**
 * Placement Swarm d'un service : mappé sur TaskTemplate.
 * Optionnel — aucune
 * représentation UI requise en V1 (généré par les providers database pour la
 * distribution des membres). Tant que le mapping n'est pas appliqué dans
 * buildServiceSpec, cette config est ignorée silencieusement.
 */
export const PlacementSchema = z.object({
  /** Contraintes d'emplacement (ex: ["node.role==worker", "node.labels.rack==a"]). */
  constraints: z.array(z.string()).default([]),
  /** Préférences de répartition spread (ex: ["node.labels.rack"]). */
  spreadOver: z.array(z.string()).default([]),
})
export type Placement = z.infer<typeof PlacementSchema>

export const ContainerConfigSchema = z.object({
  image: z.string().min(1),
  tag: z.string().min(1).default("latest"),
  /** Politique de pull de l'image (défaut dérivé du tag si absent). */
  pullPolicy: PullPolicySchema.optional(),
  /** Variables d'environnement NON sensibles. Les secrets passent par `secrets`. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Secrets référencés par le service (Docker Secrets, JAMAIS en clair dans les
   * labels ni l'env). Chaque entrée = nom logique -> nom du Docker Secret réel.
   * La VALEUR n'est pas ici : elle est posée via l'API (createSecret) et montée en
   * fichier dans /run/secrets/<name>. On ne stocke que la référence.
   */
  secrets: z.array(SecretRefSchema).default([]),
  /** Commande de surcharge (forme exec). */
  cmd: z.array(z.string()).optional(),
  ports: z.array(PortMappingSchema).default([]),
  restartPolicy: RestartPolicySchema.default("unless-stopped"),
  resources: ResourcesSchema.optional(),
  healthcheck: HealthcheckSchema.optional(),
  /** Placement Swarm optionnel (Constraints + Spread). */
  placement: PlacementSchema.optional(),
  // ── Swarm : chaque conteneur est un SERVICE répliqué ──
  /** Nombre de replicas (load balancing natif via routing mesh). */
  replicas: z.number().int().min(0).default(1),
  /** Rolling update : nombre de tasks mises à jour en parallèle. */
  updateParallelism: z.number().int().min(1).default(1),
  /** Rolling update : délai (s) entre deux lots de tasks. */
  updateDelaySec: z.number().int().min(0).default(5),
  /**
   * Auto-scaling (Swarm ne le fait PAS nativement — c'est l'auto-scaler de l'outil
   * qui ajuste `replicas` entre min/max selon la charge CPU observée). Désactivé par
   * défaut : le service garde son nombre de replicas fixe.
   */
  autoscale: AutoscaleSchema.optional(),
})
export type ContainerConfig = z.infer<typeof ContainerConfigSchema>

/**
 * Politique de pull EFFECTIVE d'un conteneur : explicite si fournie, sinon dérivée
 * du tag à la manière de Kubernetes — `latest` (mutable) ⇒ `Always` (anti-CI/CD-cassé),
 * tag fixe ⇒ `IfNotPresent`. Partagée back (deploy) + front (affichage du défaut déduit).
 */
export function effectivePullPolicy(config: Pick<ContainerConfig, "tag" | "pullPolicy">): PullPolicy {
  if (config.pullPolicy) return config.pullPolicy
  return config.tag === "latest" ? "Always" : "IfNotPresent"
}

// ── Réseau ───────────────────────────────────────────────────────────────────

export const NetworkConfigSchema = z.object({
  // Swarm : overlay attachable par défaut (requis pour relier des services).
  driver: z.enum(["overlay", "bridge"]).default("overlay"),
  /** Réseau interne (pas d'accès sortant). */
  internal: z.boolean().default(false),
  /** Permet à des conteneurs hors stack de s'y rattacher (docker network connect). */
  attachable: z.boolean().default(true),
  /** Labels Docker additionnels (fusionnés AVEC, jamais à la place des labels bozando.* gérés). */
  labels: z.record(z.string(), z.string()).default({}),
  /** IPAM custom. Laisser vide = Docker choisit automatiquement. */
  ipam: z
    .object({
      subnet: z.string().optional(),
      gateway: z.string().optional(),
    })
    .optional(),
})
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>

// ── Volume ───────────────────────────────────────────────────────────────────

export const VolumeConfigSchema = z
  .object({
    driver: z.string().default("local"),
    /** Options spécifiques au driver (ex: NFS — type=nfs, o=addr=...,rw, device=:/path). */
    driverOpts: z.record(z.string(), z.string()).default({}),
    labels: z.record(z.string(), z.string()).default({}),
    /**
     * Volume EXTERNE : référence un volume Docker préexistant par son nom EXACT
     * (pas préfixé boz_<slug>_) au lieu d'en créer/gérer un. Le déploiement saute
     * la création et utilise ce nom directement dans les mounts.
     */
    external: z.boolean().default(false),
    /** Nom du volume externe (requis si external=true). */
    externalName: z.string().optional(),
  })
  .refine((v) => !v.external || (v.externalName && v.externalName.length > 0), {
    message: "externalName requis quand external=true",
    path: ["externalName"],
  })
export type VolumeConfig = z.infer<typeof VolumeConfigSchema>

// ── Passerelle internet (exposition publique via Caddy) ──────────────────────

export const GatewayConfigSchema = z.object({
  /** Domaine public (ex: app.bozando.com). Caddy gère HTTPS automatiquement. */
  domain: z.string().min(1),
  /** Port du conteneur cible vers lequel router. */
  targetPort: z.number().int().min(1).max(65535),
  tls: z.boolean().default(true),
})
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>

// ── Base de données (nœud de composition, JAMAIS une ressource runtime) ──────

export const DatabaseEngineSchema = z.enum(["postgres", "mysql", "mongodb", "redis"])
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>

export const DatabaseModeSchema = z.enum(["single", "ha"])
export type DatabaseMode = z.infer<typeof DatabaseModeSchema>

/**
 * Topologie de la base. Les data-replicas et les replicas de consensus
 * (etcd/Sentinel…) sont DEUX AXES DISTINCTS : chacun a ses propres
 * règles de validation côté provider, aucune règle globale « impair » ici.
 */
export const DatabaseTopologySchema = z.object({
  /**
   * Nombre de membres data. Optionnel : le défaut est PAR MOTEUR (defaultReplicas
   * dans le module database) — ne pas codifier un défaut global ici, sinon une
   * config `mode: "ha"` sans topology hériterait de `replicas: 1`, contradictoire
   * avec les règles du moteur.
   */
  replicas: z.number().int().min(1).optional(),
  /**
   * Nombre de replicas de consensus/coordination (etcd, Sentinel, voteur…).
   * Découplé de `replicas` ; défaut par moteur si absent. Interdit quand le
   * moteur/mode n'a pas de consensus (validation dans le module database).
   */
  consensusReplicas: z.number().int().min(1).optional(),
})
export type DatabaseTopology = z.infer<typeof DatabaseTopologySchema>

export const DatabaseStorageSchema = z
  .object({
    /** Taille souhaitée du volume de données (Go). Informative, non provisionnée en V1. */
    sizeGb: z.number().positive().optional(),
    driver: z.string().default("local"),
    driverOpts: z.record(z.string(), z.string()).default({}),
    /** Volume EXTERNE préexistant (comme VolumeConfig.external). */
    external: z.boolean().default(false),
    externalName: z.string().optional(),
  })
  .refine((s) => !s.external || (s.externalName && s.externalName.length > 0), {
    message: "externalName requis quand external=true",
    path: ["externalName"],
  })
export type DatabaseStorage = z.infer<typeof DatabaseStorageSchema>

/**
 * Credentials de la base. Le mot de passe n'est JAMAIS stocké : seule une
 * référence vers un Docker Secret (passwordSecretRef) existe dans la config.
 * Règle de sécurité : la valeur ne doit pas finir en clair dans les
 * labels Docker ni dans l'env. Schema STRICT : toute clé inconnue (ex. un
 * `password` en clair) est rejetée au lieu d'être silencieusement ignorée.
 */
export const DatabaseCredentialsSchema = z
  .object({
    username: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "username : [A-Za-z0-9_-] uniquement (interpolé dans cmd/healthcheck)"),
    /** Référence à un Docker Secret (module Secrets). Jamais la valeur.
     *  Optionnelle en config : un nœud neuf n'a pas encore de secret choisi.
     *  Le déploiement (provider.validate) l'exige et guide vers l'action. */
    passwordSecretRef: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
        "passwordSecretRef : doit être un nom de secret Docker valide"
      )
      .optional(),
    database: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "database : [A-Za-z0-9_-] uniquement (interpolé dans les URL de connexion)"
      ),
  })
  .strict()
export type DatabaseCredentials = z.infer<typeof DatabaseCredentialsSchema>

export const DatabaseConfigSchema = z.object({
  engine: DatabaseEngineSchema,
  /** Version explicite — jamais "latest" en production. */
  version: z
    .string()
    .min(1)
    .refine((v) => v !== "latest", {
      message: "version explicite requise (jamais \"latest\")",
    }),
  mode: DatabaseModeSchema.default("single"),
  topology: DatabaseTopologySchema.default({}),
  storage: DatabaseStorageSchema.default({}),
  resources: ResourcesSchema.optional(),
  credentials: DatabaseCredentialsSchema,
  /**
   * Rétention des données à la suppression par défaut TRUE.
   * Les volumes de données sont labellisés bozando.database.data=true et exclus
   * des trois chemins de suppression (destroy, volumesStep, prune-orphans).
   */
  retainDataOnDelete: z.boolean().default(true),
})
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>

// ── Union discriminée par type de nœud ───────────────────────────────────────

export const NodeType = z.enum(["container", "network", "volume", "gateway", "database"])
export type NodeType = z.infer<typeof NodeType>

// ── Matrice de compatibilité des connexions (GNS3-like) ──────────────────────

type EdgeKindLiteral = "network" | "volume" | "gateway" | "database"

/**
 * Paires de nœuds qu'il est sémantiquement possible de relier, et la nature
 * (kind) du lien résultant. Tout ce qui n'est pas listé ici est INTERDIT —
 * ex: volume<->gateway, network<->network, container<->container.
 *
 * Source unique partagée front (isValidConnection au drag) + back (createEdge,
 * défense en profondeur) : zéro risque de dérive entre les deux validations.
 */
const CONNECTION_RULES: { a: NodeType; b: NodeType; kind: EdgeKindLiteral }[] = [
  { a: "container", b: "network", kind: "network" },
  { a: "container", b: "volume", kind: "volume" },
  { a: "container", b: "gateway", kind: "gateway" },
  // Dépendance applicative app→base : l'expansion injectera env + edge réseau.
  { a: "container", b: "database", kind: "database" },
]

const RULE_BY_PAIR = new Map<string, EdgeKindLiteral>(
  CONNECTION_RULES.flatMap((r) => [
    [`${r.a}|${r.b}`, r.kind] as const,
    [`${r.b}|${r.a}`, r.kind] as const,
  ])
)

/** Nature du lien entre deux types de nœuds, ou `null` si la paire est interdite. */
export function edgeKindForPair(a: NodeType, b: NodeType): EdgeKindLiteral | null {
  return RULE_BY_PAIR.get(`${a}|${b}`) ?? null
}

/** Vrai si les deux types de nœuds peuvent être reliés directement. */
export function isConnectionAllowed(a: NodeType, b: NodeType): boolean {
  return RULE_BY_PAIR.has(`${a}|${b}`)
}

/**
 * Map type → schéma de config. Utilisé pour valider dynamiquement la config
 * d'un nœud selon son type.
 */
export const NodeConfigSchemas = {
  container: ContainerConfigSchema,
  network: NetworkConfigSchema,
  volume: VolumeConfigSchema,
  gateway: GatewayConfigSchema,
  database: DatabaseConfigSchema,
} as const

export type NodeConfigByType = {
  container: ContainerConfig
  network: NetworkConfig
  volume: VolumeConfig
  gateway: GatewayConfig
  database: DatabaseConfig
}

/** Valide la config d'un nœud selon son type. Lève si invalide. */
export function parseNodeConfig<T extends NodeType>(
  type: T,
  config: unknown
): NodeConfigByType[T] {
  return NodeConfigSchemas[type].parse(config) as NodeConfigByType[T]
}
