import { Text, Tooltip } from "@medusajs/ui"
import type { ClusterHealth } from "../lib/api"
import { colorForSwarmNode, TAG_CLASSES } from "../lib/clusterNodeColors"

/**
 * Barre flottante (overlay bas-gauche du canvas) listant les nœuds Swarm du
 * cluster sur lequel tourne le projet, avec la MÊME couleur que celle utilisée
 * pour les couches de la pile de replicas (OpsNode/NodeStackWrapper) —
 * colorForSwarmNode partagée, importée depuis lib/clusterNodeColors.ts (SOURCE
 * UNIQUE — ne jamais redéfinir TAG_CLASSES/colorForSwarmNode localement ici,
 * sinon la couleur d'un nœud peut diverger entre la barre et la pile).
 */
export function ClusterNodesBar({ cluster }: { cluster: ClusterHealth | undefined }) {
  if (!cluster || cluster.nodes.length === 0) return null

  const orderedIds = cluster.nodes.map((n) => n.swarmNodeId)

  return (
    <div
      className="absolute bottom-4 z-10 flex items-center gap-1.5 rounded-lg
                 border border-ui-border-base bg-ui-bg-base/95 px-2 py-1.5 shadow-elevation-flyout backdrop-blur"
      style={{ left: '58px' }}
      role="status"
      aria-label="Nœuds du cluster Swarm"
    >
      {cluster.nodes.map((n) => {
        const color = colorForSwarmNode(n.swarmNodeId, orderedIds)
        const cls = TAG_CLASSES[color]
        const stateOk = n.state === "ready" && n.availability === "active"
        return (
          <Tooltip
            key={n.swarmNodeId}
            content={`${n.hostname} · ${n.role}${n.leader ? " (leader)" : ""} · ${n.state}/${n.availability}`}
          >
            <span className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${cls.border} ${cls.bg}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${stateOk ? cls.icon : TAG_CLASSES.red.icon}`} />
              <Text size="xsmall" className={cls.text}>
                {n.hostname}
              </Text>
            </span>
          </Tooltip>
        )
      })}
    </div>
  )
}