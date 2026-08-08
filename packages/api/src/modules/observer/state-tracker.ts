/**
 * ContainerStateTracker — agrégation pure des états conteneurs -> état par nœud.
 *
 * POURQUOI : Docker émet un flux d'events "container" où PLUSIEURS conteneurs
 * physiques partagent le même nodeId (replicas, ancien + nouveau conteneur pendant
 * un rolling update start-first). Un relais "dernier event gagne par nœud" faisait
 * flapper l'interface entre running/exited/missing sur un service pourtant sain.
 *
 * Règle de résolution : l'état affiché d'un nœud = le MEILLEUR état parmi tous ses
 * conteneurs courants (priorité running > restarting > created > paused > dead >
 * exited > missing).
 *  - Rolling update : l'ancien conteneur qui meurt ne fait plus tomber l'état
 *    tant que le nouveau tourne (running l'emporte sur exited/missing).
 *  - Crash réel : TOUS les conteneurs d'un nœud hors service -> exited ressort.
 *  - Destroy d'un projet : plus aucun conteneur -> missing.
 *
 * Aucune I/O, aucune dépendance : module pur, testable sans Docker ni Postgres.
 */

export type ContainerState =
  | "running"
  | "restarting"
  | "created"
  | "paused"
  | "dead"
  | "exited"
  | "missing"
  | "unknown"

/** Ordre de priorité : l'état le plus proche du début est le plus « sain ». */
const STATE_RANK: Record<ContainerState, number> = {
  running: 0,
  restarting: 1,
  created: 2,
  paused: 3,
  dead: 4,
  exited: 5,
  unknown: 6,
  missing: 7,
}

interface ContainerEntry {
  nodeId: string
  state: ContainerState
}

export class ContainerStateTracker {
  /** dockerId -> entrée. Plusieurs conteneurs peuvent pointer le même nodeId. */
  private containers = new Map<string, ContainerEntry>()
  /** Dernier état résolu émis par nœud (dédup des emissions). */
  private emittedByNode = new Map<string, ContainerState>()

  /**
   * Enregistre l'état d'un conteneur (ou l'oublie si "missing"), recalcule l'état
   * résolu du nœud. Renvoie le nouvel état UNIQUEMENT s'il a changé par rapport à
   * la dernière emission — sinon null (dédup par nœud, pas par event).
   */
  apply(dockerId: string, nodeId: string, state: ContainerState): ContainerState | null {
    if (state === "missing") {
      this.containers.delete(dockerId)
    } else {
      this.containers.set(dockerId, { nodeId, state })
    }
    return this.changedEmit(nodeId, this.resolve(nodeId))
  }

  /** État résolu d'un nœud (lecture seule). */
  resolve(nodeId: string): ContainerState {
    let best: ContainerState = "missing"
    let bestRank = Number.POSITIVE_INFINITY
    for (const c of this.containers.values()) {
      if (c.nodeId !== nodeId) continue
      const rank = STATE_RANK[c.state]
      if (rank < bestRank) {
        bestRank = rank
        best = c.state
      }
    }
    return best
  }

  /** Purge tout l'état d'un nœud (ex : project destroy) -> missing. */
  clearNode(nodeId: string): ContainerState | null {
    for (const [dockerId, c] of this.containers) {
      if (c.nodeId === nodeId) this.containers.delete(dockerId)
    }
    return this.changedEmit(nodeId, "missing")
  }

  private changedEmit(nodeId: string, next: ContainerState): ContainerState | null {
    if (this.emittedByNode.get(nodeId) === next) return null
    this.emittedByNode.set(nodeId, next)
    return next
  }
}