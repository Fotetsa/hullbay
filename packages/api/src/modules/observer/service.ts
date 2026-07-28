import { LabelKeys } from "@hullbay/shared"
import { getDocker } from "../docker-engine/client"
import { DockerEngineService } from "../docker-engine/service"
import { eventBus } from "../../lib/event-bus"
import { prisma } from "../../lib/prisma"

const docker = new DockerEngineService()

/**
 * Observer — sens Réel -> Désiré (LECTURE SEULE, aucune correction auto en V1).
 *
 * Écoute les events Docker de type "container" (create/start/die/stop/kill/oom/
 * destroy/restart...) pour nos ressources gérées (bozando.managed=true), et met
 * à jour l'actualState du nœud + émet "node.state" relayé au canvas. Self-healing
 * = natif Swarm (on observe juste).
 *
 * IMPORTANT (vérifié en live sur ce cluster, Docker 29.1.3) : les events Swarm de
 * type "task" n'existent PAS — un `service update --force` complet ne produit que
 * des events "service"/"image"/"container"/"network", jamais "task". Une version
 * antérieure de ce fichier mappait sur `Type==="task"` + `updatestate.new`, ce qui
 * ne se déclenchait JAMAIS : c'est la cause du bug "l'état du nœud ne remonte pas".
 * Les events "container" portent directement tous les labels bozando.* (vu sur un
 * event réel : `Actor.Attributes` contient bozando.nodeId, bozando.managed, etc.),
 * donc c'est la bonne — et seule — source fiable pour l'état fin d'un conteneur.
 *
 * Reconnexion : si le stream Docker se coupe (redémarrage du daemon, perte du
 * socket), on retente après un délai au lieu de laisser l'observer mourir en
 * silence pour toujours (c'était le cas avant — aucun `on("end"/"error")`).
 *
 * Snapshot initial : au démarrage, avant de s'abonner au flux d'events, on lit
 * une fois l'état réel de tous les conteneurs gérés (voir `syncInitialState`) pour
 * que les ressources déjà en cours avant ce démarrage soient immédiatement
 * correctes (sinon elles restent figées jusqu'à leur prochaine transition).
 */
export function startObserver(): void {
  void syncInitialState()

  const rawDocker = getDocker()

  rawDocker.getEvents(
    {
      filters: {
        label: [`${LabelKeys.managed}=true`],
        type: ["container"],
      },
    },
    (err, stream) => {
      if (err || !stream) {
        // Pas de socket / daemon pas encore prêt : on retente plus tard plutôt
        // que d'abandonner définitivement.
        setTimeout(startObserver, 10_000)
        return
      }

      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line) as {
              Type?: string
              Action?: string
              Actor?: { Attributes?: Record<string, string> }
            }
            void handleContainerEvent(evt)
          } catch {
            // ligne partielle / non-JSON ignorée
          }
        }
      })
      // Le stream Docker peut se fermer (daemon restart, coupure du socket) sans
      // jamais rouvrir tout seul — sans ce ré-armement, l'observer reste mort
      // jusqu'au prochain restart du process API (c'était le bug initial).
      stream.on("end", () => setTimeout(startObserver, 5_000))
      stream.on("error", () => setTimeout(startObserver, 5_000))
    }
  )
}

/**
 * État dérivé d'un event "container". `Action` couvre directement la transition
 * réelle (pas besoin de creuser dans les attributs comme on le croyait pour
 * "task") : create/start = running, die/stop/kill/oom = état d'arrêt, destroy =
 * disparu. Vocabulaire aligné sur `ContainerInfo.State` (created/running/paused/
 * restarting/exited/dead) utilisé aussi par le snapshot initial.
 */
const CONTAINER_ACTION_TO_STATE: Record<string, string> = {
  create: "created",
  start: "running",
  unpause: "running",
  restart: "restarting",
  pause: "paused",
  die: "exited",
  stop: "exited",
  kill: "exited",
  oom: "dead",
  destroy: "missing",
}

async function handleContainerEvent(evt: {
  Type?: string
  Action?: string
  Actor?: { Attributes?: Record<string, string> }
}): Promise<void> {
  if (evt.Type !== "container") return
  const attrs = evt.Actor?.Attributes ?? {}
  const nodeId = attrs[LabelKeys.nodeId]
  const projectId = attrs[LabelKeys.projectId]
  const action = evt.Action ?? ""
  const state = CONTAINER_ACTION_TO_STATE[action]
  if (!nodeId || !state) return

  // Met à jour le reflet runtime (NON source de vérité).
  await prisma.node
    .update({ where: { id: nodeId }, data: { actualState: state } })
    .catch(() => {
      // nœud inconnu en base (ex: avant rebuild) — on émet quand même l'event live
    })

  await eventBus.emit("node.state", {
    projectId,
    nodeId,
    state,
    dockerStatus: `container:${action}`,
  })

  scheduleReplicaRecount(nodeId, projectId)
}

/**
 * Recompte (debounced) les replicas RUNNING réels d'un service après un event
 * conteneur — affiche le "stack" du canvas avec le nombre VRAI de tasks up, pas
 * la valeur désirée (`config.replicas`) qui peut diverger temporairement (crash
 * loop, rolling update en cours, scale en cours). Un deploy/destroy déclenche
 * une rafale d'events pour le même service : debounce courte par nœud pour
 * éviter une tempête d'appels `getServiceMetrics` (coûteux : inspect + stats
 * CPU par task).
 */
const REPLICA_DEBOUNCE_MS = 800
const pendingRecount = new Map<string, NodeJS.Timeout>()

function scheduleReplicaRecount(nodeId: string, projectId: string | undefined): void {
  const existing = pendingRecount.get(nodeId)
  if (existing) clearTimeout(existing)
  pendingRecount.set(
    nodeId,
    setTimeout(() => {
      pendingRecount.delete(nodeId)
      void recountReplicas(nodeId, projectId)
    }, REPLICA_DEBOUNCE_MS)
  )
}

async function recountReplicas(nodeId: string, projectId: string | undefined): Promise<void> {
  try {
    const serviceId = await docker.findServiceIdByNodeId(nodeId)
    if (!serviceId) {
      // Service disparu (destroy) : 0 replica live.
      await eventBus.emit("node.replicas", { projectId, nodeId, runningReplicas: 0 })
      return
    }
    const metrics = await docker.getServiceMetrics(serviceId)
    await eventBus.emit("node.replicas", {
      projectId,
      nodeId,
      runningReplicas: metrics.runningReplicas,
    })
  } catch {
    // service/conteneur disparu entre l'event et la mesure — pas grave, le
    // prochain event (ou le snapshot suivant) corrigera.
  }
}

/**
 * Snapshot d'état initial au démarrage de l'observer (boot ou redémarrage de l'API).
 *
 * Le flux d'events Docker ne signale que des TRANSITIONS — un conteneur déjà en
 * "running" avant ce démarrage ne déclenche aucun nouvel event tant que rien ne
 * change. Sans ce snapshot, son `actualState` restait figé sur sa valeur précédente
 * (souvent absente/périmée) malgré un état réel correct, alors que la page Santé
 * (qui interroge Docker en direct à chaque appel) affichait la bonne info — d'où le
 * décalage canvas/Santé constaté en test live.
 */
async function syncInitialState(): Promise<void> {
  let containers: Awaited<ReturnType<typeof docker.listManagedContainers>>
  try {
    containers = await docker.listManagedContainers()
  } catch {
    // Daemon pas encore prêt au boot — le prochain cycle d'events s'en chargera.
    return
  }

  for (const c of containers) {
    const labels = c.Labels ?? {}
    const nodeId = labels[LabelKeys.nodeId]
    const projectId = labels[LabelKeys.projectId]
    const state = c.State // déjà au format created/running/paused/restarting/exited/dead
    if (!nodeId || !state) continue

    await prisma.node
      .update({ where: { id: nodeId }, data: { actualState: state } })
      .catch(() => {})

    await eventBus.emit("node.state", {
      projectId,
      nodeId,
      state,
      dockerStatus: `container:snapshot:${state}`,
    })

    // Plusieurs conteneurs (replicas) peuvent partager le même nodeId : le debounce
    // de scheduleReplicaRecount déduplique déjà les appels redondants par nœud.
    scheduleReplicaRecount(nodeId, projectId)
  }
}
