import { Text, Tooltip, TooltipProvider } from "@medusajs/ui"
import { useState } from "react"
import type { ClusterHealth } from "../lib/api"
import { colorForSwarmNode, TAG_CLASSES } from "../lib/clusterNodeColors"

/**
 * Barre flottante (overlay bas-gauche du canvas) listant les nœuds Swarm du
 * cluster sur lequel tourne le projet, avec la MÊME couleur que celle utilisée
 * pour les couches de la pile de replicas (OpsNode) — colorForSwarmNode partagée.
 *
 * `cluster` est directement le `ClusterHealth` déjà filtré par CanvasPage (une
 * seule requête `api.clusterHealth()` levée au niveau de la page, partagée avec
 * la pile 3D des replicas).
 *
 * Positionnement : ancrée en bas à gauche, juste à droite des `<Controls />` de
 * React Flow (qui occupent ~44px + leur marge par défaut `left-4`/`bottom-4`).
 */
export function ClusterNodesBar({ cluster }: { cluster: ClusterHealth | undefined }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!cluster || cluster.nodes.length === 0) return null

  const orderedIds = cluster.nodes.map((n) => n.swarmNodeId)

  return (
    <TooltipProvider>
      <div
        className="absolute bottom-4 left-[48px] z-10 flex items-center gap-2 rounded-lg
                   border border-ui-border-base bg-ui-bg-base/95 px-2 py-1 shadow-elevation-flyout backdrop-blur cursor-pointer"
        onClick={() => setCollapsed((c) => !c)}
        role="status"
        aria-label="Nœuds du cluster Swarm"
      >
        {/* click anywhere on the bar to toggle; clicks on badges stop propagation below */}

        {!collapsed ? (
          <div className="flex items-center gap-1.5">
            {cluster.nodes.map((n) => {
              const color = colorForSwarmNode(n.swarmNodeId, orderedIds)
              const cls = TAG_CLASSES[color]
              const stateOk = n.state === "ready" && n.availability === "active"
              return (
                <Tooltip
                  key={n.swarmNodeId}
                  content={`${n.hostname} · ${n.role}${n.leader ? " (leader)" : ""} · ${n.state}/${n.availability}`}
                >
                  <span onClick={(e) => e.stopPropagation()} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${cls.border} ${cls.bg}`}>
                    <span className={`h-2 w-2 rounded-full ${stateOk ? cls.icon : TAG_CLASSES.red.icon}`} />
                    <Text size="xsmall" className={cls.text}>
                      {n.hostname}
                    </Text>
                  </span>
                </Tooltip>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Text size="xsmall" className="text-ui-fg-subtle">
              {cluster.nodes.length} nœud{cluster.nodes.length > 1 ? "s" : ""}
            </Text>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}