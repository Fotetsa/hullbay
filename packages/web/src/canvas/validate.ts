import type { ProjectGraph, Node, Edge } from "@bozando-ops/shared"

/**
 * Validation de cohérence du graphe AVANT déploiement (référence : Azure "Review +
 * create" / les linters d'infra). Pur, sans I/O, donc testable et réutilisable.
 *
 * On distingue :
 *  - `errors`   : incohérences qui feront échouer ou rendront inutile le déploiement
 *                 (passerelle sans cible, conteneur sans image…). Bloquant côté UI.
 *  - `warnings` : choses probablement non voulues mais déployables (conteneur sans
 *                 réseau, volume orphelin). Non bloquant.
 */
export type Severity = "error" | "warning"

export type ValidationIssue = {
  severity: Severity
  nodeId?: string
  message: string
}

type ContainerConfig = {
  image?: string
  ports?: { host?: number; container: number }[]
}
type GatewayConfig = { domain?: string; targetPort?: number }

export function validateGraph(graph: ProjectGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { nodes, edges } = graph

  const containers = nodes.filter((n) => n.type === "container")
  const gateways = nodes.filter((n) => n.type === "gateway")
  const volumes = nodes.filter((n) => n.type === "volume")

  // Index des liens par nœud impliqué.
  const edgesByNode = new Map<string, Edge[]>()
  for (const e of edges) {
    edgesByNode.set(e.sourceNodeId, [...(edgesByNode.get(e.sourceNodeId) ?? []), e])
    edgesByNode.set(e.targetNodeId, [...(edgesByNode.get(e.targetNodeId) ?? []), e])
  }
  const hasEdgeOfKind = (nodeId: string, kind: Edge["kind"]) =>
    (edgesByNode.get(nodeId) ?? []).some((e) => e.kind === kind)

  // ── Conteneurs ──
  for (const c of containers) {
    const cfg = c.config as ContainerConfig
    if (!cfg.image || !String(cfg.image).trim()) {
      issues.push({ severity: "error", nodeId: c.id, message: `« ${c.name} » : image manquante.` })
    }
    if (!hasEdgeOfKind(c.id, "network")) {
      issues.push({
        severity: "warning",
        nodeId: c.id,
        message: `« ${c.name} » n'est relié à aucun réseau (isolé, joignable seulement via passerelle).`,
      })
    }
  }

  // ── Passerelles : doivent cibler exactement un conteneur ──
  for (const g of gateways) {
    const cfg = g.config as GatewayConfig
    const links = (edgesByNode.get(g.id) ?? []).filter((e) => e.kind === "gateway")
    if (links.length === 0) {
      issues.push({
        severity: "error",
        nodeId: g.id,
        message: `Passerelle « ${g.name} » sans conteneur cible : aucune route ne sera créée.`,
      })
    }
    if (!cfg.domain || !String(cfg.domain).trim()) {
      issues.push({
        severity: "error",
        nodeId: g.id,
        message: `Passerelle « ${g.name} » : domaine manquant.`,
      })
    }
  }

  // ── Volumes orphelins (non montés) ──
  for (const v of volumes) {
    if (!hasEdgeOfKind(v.id, "volume")) {
      issues.push({
        severity: "warning",
        nodeId: v.id,
        message: `Volume « ${v.name} » n'est monté sur aucun conteneur.`,
      })
    }
  }

  // ── Ports hôte publiés en double (conflit garanti au déploiement) ──
  const hostPorts = new Map<number, string[]>()
  for (const c of containers) {
    const cfg = c.config as ContainerConfig
    for (const p of cfg.ports ?? []) {
      if (p.host) hostPorts.set(p.host, [...(hostPorts.get(p.host) ?? []), c.name])
    }
  }
  for (const [port, owners] of hostPorts) {
    if (owners.length > 1) {
      issues.push({
        severity: "error",
        message: `Port hôte ${port} publié par plusieurs conteneurs (${owners.join(", ")}) : conflit.`,
      })
    }
  }

  // ── Chemins de montage en double sur un même conteneur ──
  // Docker refuse deux volumes montés sur le MÊME chemin. On reproduit ici le
  // calcul du backend (deploy-project.volumeMountsFor) : chemin = edge.mountPath
  // ou, à défaut, `/data/<nom-du-volume>`. Deux montages au même chemin = conflit.
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const c of containers) {
    const pathOwners = new Map<string, string[]>()
    for (const e of edgesByNode.get(c.id) ?? []) {
      if (e.kind !== "volume") continue
      const otherId = e.sourceNodeId === c.id ? e.targetNodeId : e.sourceNodeId
      const vol = nodeById.get(otherId)
      if (!vol || vol.type !== "volume") continue
      const mountPath =
        (e.config as { mountPath?: string } | null)?.mountPath?.trim() || `/data/${vol.name}`
      pathOwners.set(mountPath, [...(pathOwners.get(mountPath) ?? []), vol.name])
    }
    for (const [path, vols] of pathOwners) {
      if (vols.length > 1) {
        issues.push({
          severity: "error",
          nodeId: c.id,
          message: `« ${c.name} » : plusieurs volumes (${vols.join(", ")}) montés sur le même chemin ${path}. Donne un chemin de montage distinct à chacun.`,
        })
      }
    }
  }

  return issues
}

/**
 * État de déploiement d'un nœud par rapport au désiré, pour l'affichage canvas :
 *  - "deployed" : la ressource a été déployée
 *  - "pending"  : existe dans le désiré mais pas encore déployée
 *  - "drift"    : déployée mais le projet a un statut divergent (partial/error)
 *
 * Un nœud est considéré déployé dès qu'il a un `dockerId` OU un `actualState` non
 * vide. C'est essentiel pour les nœuds SANS dockerId/cycle de vie observable
 * (volume, passerelle) : le workflow leur pose actualState="running" au déploiement,
 * sinon ils resteraient éternellement "à déployer". `missing` (détruit) = pending.
 */
export type NodeDeployState = "deployed" | "pending" | "drift"

export function nodeDeployState(node: Node, projectStatus: string): NodeDeployState {
  const deployed = Boolean(node.dockerId) || (!!node.actualState && node.actualState !== "missing")
  if (!deployed) return "pending"
  if (projectStatus === "partial" || projectStatus === "error") return "drift"
  return "deployed"
}

/**
 * État LOGIQUE d'une passerelle (route Caddy), distinct du cycle de vie d'un
 * conteneur : une route n'est ni "running" ni "exited". On dérive l'état utile
 * façon santé d'upstream nginx :
 *  - "pending"  : route pas encore déployée (rien dans Caddy) -> "à déployer".
 *  - "online"   : route déployée ET le conteneur cible est actif (running) ->
 *                 le mapping domaine -> upstream résout réellement.
 *  - "offline"  : route déployée mais cible absente/arrêtée (ou aucune cible) ->
 *                 le domaine répondrait 502. C'est l'info vraiment utile.
 *
 * `gatewayDeployed` : la passerelle a-t-elle été appliquée (cf. nodeDeployState).
 * `targetState`     : actualState du conteneur ciblé par l'edge gateway, ou null.
 */
export type GatewayState = "online" | "offline" | "pending"

export function gatewayState(
  gatewayDeployed: boolean,
  targetState: string | null | undefined
): GatewayState {
  if (!gatewayDeployed) return "pending"
  return targetState === "running" ? "online" : "offline"
}
