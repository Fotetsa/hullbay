import { createHash } from "node:crypto"
import type { Node, Edge } from "./entities.js"
import { NodeType } from "./node-config.js"

/**
 * Helpers des labels Docker `bozando.*`.
 *
 * PRINCIPE DIRECTEUR : on stocke le MAXIMUM d'informations dans les labels pour
 * pouvoir reconstruire l'intégralité du désiré depuis Docker seul (rebuildFromDocker),
 * même si PostgreSQL est perdu. Docker = source de vérité redondante ; Postgres = cache.
 *
 * Contraintes Docker : valeurs de label = strings uniquement. On vise < 4 KB par
 * label et < ~16 KB cumulés. Les configs complexes (spec, edges) sont encodées en
 * JSON puis base64 (évite tout souci d'échappement dans inspect/CLI/Caddy).
 */

/** Version du schéma de labels — permet des migrations futures. */
export const LABEL_SCHEMA_VERSION = "1"

/** Préfixe commun de tous nos labels. */
const NS = "bozando"

export const LabelKeys = {
  managed: `${NS}.managed`,
  system: `${NS}.system`,
  version: `${NS}.version`,
  projectId: `${NS}.projectId`,
  projectSlug: `${NS}.projectSlug`,
  nodeId: `${NS}.nodeId`,
  nodeName: `${NS}.nodeName`,
  nodeType: `${NS}.nodeType`,
  canvasX: `${NS}.canvas.x`,
  canvasY: `${NS}.canvas.y`,
  desiredHash: `${NS}.desiredHash`,
  spec: `${NS}.spec`,
  edges: `${NS}.edges`,
  createdBy: `${NS}.createdBy`,
  createdAt: `${NS}.createdAt`,
} as const

/** Taille max recommandée d'une valeur de label encodée (garde-fou). */
export const MAX_LABEL_VALUE_BYTES = 4096

// ── base64(JSON) ─────────────────────────────────────────────────────────────

export function encodeJsonLabel(value: unknown): string {
  const json = JSON.stringify(value)
  const b64 = Buffer.from(json, "utf8").toString("base64")
  if (Buffer.byteLength(b64, "utf8") > MAX_LABEL_VALUE_BYTES) {
    throw new Error(
      `Label trop volumineux (${Buffer.byteLength(b64, "utf8")} > ${MAX_LABEL_VALUE_BYTES} octets). ` +
        `Réduire la config (secrets hors labels).`
    )
  }
  return b64
}

export function decodeJsonLabel<T = unknown>(value: string | undefined): T | null {
  if (!value) return null
  try {
    const json = Buffer.from(value, "base64").toString("utf8")
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

// ── Hash de config désirée (idempotence du diff) ─────────────────────────────

/**
 * Hash stable de la config désirée d'un nœud. Le reconciler compare ce hash au
 * label bozando.desiredHash du conteneur réel : identique → no-op, différent →
 * recreate. La stabilité repose sur un tri des clés.
 */
export function computeDesiredHash(input: {
  type: NodeType
  name: string
  config: unknown
}): string {
  const stable = stableStringify({
    type: input.type,
    name: input.name,
    config: input.config,
  })
  return "sha256:" + createHash("sha256").update(stable).digest("hex")
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  )
}

// ── Construction des labels pour une ressource déployée ──────────────────────

export type EdgeSummary = {
  targetNodeName: string
  kind: string
  config?: Record<string, unknown> | null
}

export interface BuildLabelsInput {
  projectId: string
  projectSlug: string
  node: Pick<Node, "id" | "name" | "type" | "posX" | "posY" | "config">
  /** Liens sortants du nœud, résumés pour reconstruire les Edges depuis Docker. */
  outgoingEdges: EdgeSummary[]
  createdBy?: string
}

/**
 * Construit le jeu complet de labels bozando.* à apposer sur une ressource Docker
 * (conteneur / réseau / volume). Stocke assez d'infos pour rebuildFromDocker.
 */
export function buildBozandoLabels(input: BuildLabelsInput): Record<string, string> {
  const { projectId, projectSlug, node, outgoingEdges, createdBy } = input

  const labels: Record<string, string> = {
    [LabelKeys.managed]: "true",
    [LabelKeys.version]: LABEL_SCHEMA_VERSION,
    [LabelKeys.projectId]: projectId,
    [LabelKeys.projectSlug]: projectSlug,
    [LabelKeys.nodeId]: node.id,
    [LabelKeys.nodeName]: node.name,
    [LabelKeys.nodeType]: node.type,
    [LabelKeys.canvasX]: String(node.posX),
    [LabelKeys.canvasY]: String(node.posY),
    [LabelKeys.desiredHash]: computeDesiredHash({
      type: node.type,
      name: node.name,
      config: node.config,
    }),
    [LabelKeys.spec]: encodeJsonLabel(node.config),
    [LabelKeys.edges]: encodeJsonLabel(outgoingEdges),
    [LabelKeys.createdAt]: new Date().toISOString(),
  }

  if (createdBy) {
    labels[LabelKeys.createdBy] = createdBy
  }

  return labels
}

/** Filtre dockerode pour ne lister QUE nos ressources gérées. */
export function managedFilter(): { label: string[] } {
  return { label: [`${LabelKeys.managed}=true`] }
}

/** Filtre dockerode pour un projet donné. */
export function projectFilter(projectId: string): { label: string[] } {
  return { label: [`${LabelKeys.managed}=true`, `${LabelKeys.projectId}=${projectId}`] }
}

// ── Décodage : reconstruire un nœud depuis les labels d'une ressource Docker ──

export interface DecodedResource {
  projectId: string
  projectSlug: string
  nodeId: string
  nodeName: string
  nodeType: NodeType
  posX: number
  posY: number
  desiredHash: string | null
  config: Record<string, unknown> | null
  /** true si la config a dû être reconstruite hors de bozando.spec (dégradée). */
  degraded: boolean
  outgoingEdges: EdgeSummary[]
}

/**
 * Décode les labels d'une ressource Docker en données reconstruites.
 * Pilier de rebuildFromDocker() : si bozando.spec est lisible, on récupère tout ;
 * sinon le caller (api) reconstruira une config approximative depuis inspect.
 */
export function decodeBozandoLabels(
  labels: Record<string, string> | undefined
): DecodedResource | null {
  if (!labels || labels[LabelKeys.managed] !== "true") return null

  const nodeType = labels[LabelKeys.nodeType]
  if (!nodeType || !["container", "network", "volume", "gateway"].includes(nodeType)) {
    return null
  }

  const config = decodeJsonLabel<Record<string, unknown>>(labels[LabelKeys.spec])
  const edges = decodeJsonLabel<EdgeSummary[]>(labels[LabelKeys.edges]) ?? []

  return {
    projectId: labels[LabelKeys.projectId] ?? "",
    projectSlug: labels[LabelKeys.projectSlug] ?? "",
    nodeId: labels[LabelKeys.nodeId] ?? "",
    nodeName: labels[LabelKeys.nodeName] ?? "",
    nodeType: nodeType as NodeType,
    posX: Number(labels[LabelKeys.canvasX] ?? 0),
    posY: Number(labels[LabelKeys.canvasY] ?? 0),
    desiredHash: labels[LabelKeys.desiredHash] ?? null,
    config,
    degraded: config === null,
    outgoingEdges: edges,
  }
}
