import {
  parseNodeConfig,
  type ProjectGraph,
  type Edge,
  type Node,
} from "@hullbay/shared"
import { getDatabaseProvider } from "./providers/index.js"
import { validateDatabaseConfig } from "./validation.js"
import { DatabaseValidationError } from "./validation.js"
import type {
  DatabaseConfig,
  DatabaseEngine,
  DatabaseRole,
  ConnectionEndpoint,
  ExpansionContext,
  GeneratedResource,
} from "./types.js"

/**
 * EXPANSION DE TOPOLOGIE.
 *
 * Transforme le graphe PERSISTÉ (qui contient des nœuds `database`, des nœuds de
 * COMPOSITION) en un graphe DÉPLOYABLE : membres, consensus, endpoints/réseau/
 * volumes générés par les providers, edges internes, edge réseau app→base et env
 * injectée dans les conteneurs applicatifs dépendants (edge `database`).
 *
 * PROPRIÉTÉS :
 *  - pur (aucun accès Docker/Prisma), déterministe, testable sans daemon ;
 *  - en mémoire : les nodeIds synthétiques n'existent qu'à la durée du déploiement
 *    / plan / destroy. Rien n'est persisté (spec : pas de second ownership DB) ;
 *  - les nœuds `database` sont retirés du graphe déployable (aucune ressource
 *    runtime) et remplacés par les ressources générées.
 */

/** Métadonnées d'ownership d'une ressource générée (labels bozando.database.*). */
export interface DatabaseOwnership {
  parentNodeId: string
  parentName: string
  parentConfig: DatabaseConfig
  role: DatabaseRole
  index: number
  engine: DatabaseEngine
  /** true pour les volumes de données (rétention à la suppression). */
  data: boolean
}

export interface ExpandedProjectGraph {
  /** Graphe déployable : nœuds non-database + ressources générées. */
  graph: ProjectGraph
  /** Ownership par nodeId de ressource générée. */
  ownership: Map<string, DatabaseOwnership>
  /** Config-secrets générés, à matérialiser AVANT les services (noms versionnés). */
  generatedSecrets: { name: string; data: string }[]
}

function providerOf(config: DatabaseConfig, strict: boolean): ReturnType<typeof getDatabaseProvider> {
  const provider = getDatabaseProvider(config.engine)
  if (!provider && strict) {
    throw new DatabaseValidationError([
      `moteur ${config.engine} non implémenté (S6-S8) : impossible d'étendre ce nœud`,
    ])
  }
  return provider
}

export interface DatabaseNodePreview {
  resources: { name: string; kind: GeneratedResource["kind"]; role: DatabaseRole }[]
  connections: ConnectionEndpoint[]
}

/**
 * APERÇU lecture seule des ressources générées pour UN nœud database :
 * liste des membres/consensus/endpoints/volumes + endpoints writer/reader, pour
 * l'inspecteur UI. Même pipeline (validate → expand) que le déploiement — pas de
 * logique parallèle qui dériverait. Moteurs non implémentés → summary vide.
 * Retourne null si le nœud n'est pas une database.
 */
export function databaseNodePreview(
  graph: ProjectGraph,
  nodeId: string
): DatabaseNodePreview | null {
  const node = graph.nodes.find((n) => n.id === nodeId && n.type === "database")
  if (!node) return null
  const config = validateDatabaseConfig(node.config)
  const provider = providerOf(config, false)
  if (!provider) return { resources: [], connections: [] }
  provider.validate(config)
  const ctx: ExpansionContext = {
    parentNodeId: node.id,
    projectSlug: graph.slug,
    parentNode: { id: node.id, name: node.name, type: "database", config },
  }
  const expanded = provider.expand(config, ctx)
  return {
    resources: expanded.resources.map((r) => ({ name: r.name, kind: r.kind, role: r.role })),
    connections: expanded.connections,
  }
}

/**
 * Étend un graphe persisté en graphe déployable. `strict=false` (plan/destroy) :
 * les moteurs non implémentés sont IGNORÉS — le nœud database est conservé tel
 * quel dans le graphe (nœud de composition pur, sans ressources : niche).
 * `strict=true` (deploy) : refus catégorique (le graphe déployable ne doit pas
 * contenir de nœud `database`).
 */
export function expandDatabaseGraph(
  graph: ProjectGraph,
  { strict = true }: { strict?: boolean } = {}
): ExpandedProjectGraph {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const ownership = new Map<string, DatabaseOwnership>()
  const generatedSecrets: { name: string; data: string }[] = []

  // Passe unique sur le graphe persisté : ressources + ownership + edges
  // internes + secrets générés de chaque provider (pur, déterministe, aucune IO).
  for (const node of graph.nodes) {
    if (node.type !== "database") {
      nodes.push(node)
      continue
    }
    const config = validateDatabaseConfig(node.config)
    const provider = providerOf(config, strict)
    if (!provider) {
      // strict=false : garde le nœud database (composition) pour que le plan /
      // les diff ne le considèrent jamais comme "à détruire" ; strict=true a déjà
      // levé via providerOf. Il ne porte aucune ressource runtime ici.
      nodes.push(node)
      continue
    }

    provider.validate(config)
    const ctx: ExpansionContext = {
      parentNodeId: node.id,
      projectSlug: graph.slug,
      parentNode: { id: node.id, name: node.name, type: "database", config },
    }
    const expanded = provider.expand(config, ctx)
    for (const r of expanded.resources) {
      const type = r.kind
      nodes.push({
        id: r.nodeId,
        projectId: graph.id,
        type,
        name: r.name,
        posX: node.posX + 24,
        posY: node.posY + 24,
        config: parseNodeConfig(type, r.config) as Record<string, unknown>,
      })
      ownership.set(r.nodeId, {
        parentNodeId: node.id,
        parentName: node.name,
        parentConfig: config,
        role: r.role,
        index: r.index,
        engine: config.engine,
        data: r.kind === "volume" ? r.data : false,
      })
    }
    for (const e of expanded.edges) {
      edges.push({
        id: `gen::${e.source}::${e.target}`,
        projectId: graph.id,
        sourceNodeId: e.source,
        targetNodeId: e.target,
        kind: e.kind,
        config: (e.config as Record<string, unknown> | null | undefined),
      })
    }
    generatedSecrets.push(...expanded.generatedSecrets)
  }

  // ── Edges persisés (hors kind "database" : traité par env + edge réseau) ──
  for (const e of graph.edges) {
    if (e.kind === "database") continue
    edges.push(e)
  }

  // ── Connexion APPLICATIVE : env injectée + edge réseau app→db dans le réseau
  //    DB pour la résolution DNS Swarm du writer/reader par l'app.
  for (const e of graph.edges) {
    if (e.kind !== "database") continue
    const containerNode = graph.nodes.find(
      (n) => n.type === "container" && (n.id === e.sourceNodeId || n.id === e.targetNodeId)
    )
    // La base correspondante = l'AUTRE extrémité de CET edge (multi-bases).
    const dbNode = graph.nodes.find(
      (n) =>
        n.type === "database" &&
        (n.id === e.sourceNodeId || n.id === e.targetNodeId) &&
        n.id !== containerNode?.id
    )
    if (!containerNode || !dbNode) continue
    const config = validateDatabaseConfig(dbNode.config)
    const provider = providerOf(config, strict)
    if (!provider) continue
    const ctx: ExpansionContext = {
      parentNodeId: dbNode.id,
      projectSlug: graph.slug,
      parentNode: { id: dbNode.id, name: dbNode.name, type: "database", config },
    }
    const connections = provider.connection(config, ctx)
    const depIdx = nodes.findIndex((n) => n.id === containerNode.id)
    const dep = depIdx >= 0 ? nodes[depIdx] : undefined
    if (dep && dep.type === "container") {
      const depCfg = parseNodeConfig("container", dep.config)
      const mergedEnv = connections.reduce(
        (acc, conn) => ({ ...acc, ...conn.env }),
        depCfg.env
      )
      // L'app lit le mot de passe via DATABASE_CREDENTIALS_FILE=... : il faut que le
      // secret du provider (passwordSecretRef) soit MONTE dans le conteneur dépendant
      // (secrets[]), sans quoi /run/secrets/<ref> est absent au runtime (régressions
      // S5-11 : le lien app→base doit fournir une connexion fonctionnelle).
      const mountedNames = new Set(depCfg.secrets.map((s) => s.secretName))
      const missingNames = connections
        .map((conn) => conn.passwordSecretRef)
        .filter((name) => name && !mountedNames.has(name))
      const mergedSecrets = [...depCfg.secrets, ...missingNames.map((n) => ({ secretName: n }))]
      // COPIE du nœud (jamais mutation d'une référence partagée) : l'expansion
      // doit rester pure — une deuxième expansion du même graphe d'entrée donne
      // exactement le même résultat sans état résiduel.
      nodes[depIdx] = { ...dep, config: { ...depCfg, env: mergedEnv, secrets: mergedSecrets } }
    }
    const dbNet = nodes.find(
      (n) =>
        n.type === "network" &&
        ownership.get(n.id)?.parentNodeId === dbNode.id
    )
    if (dep && dbNet) {
      edges.push({
        id: `gen::dbnet::${dep.id}::${dbNet.id}`,
        projectId: graph.id,
        sourceNodeId: dep.id,
        targetNodeId: dbNet.id,
        kind: "network",
      })
    }
  }

  return {
    graph: { ...graph, nodes, edges },
    ownership,
    generatedSecrets,
  }
}