import { LabelKeys } from "@hullbay/shared";
import { getDockerForCluster } from "../docker-engine/client";
import { DockerEngineService } from "../docker-engine/service";
import { eventBus } from "../../lib/event-bus";
import { prisma } from "../../lib/prisma";
import { ContainerStateTracker, type ContainerState } from "./state-tracker";


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
 * AGREGATION / ANTI-FLAPPING : pendant un rolling update ou un déploiement,
 * plusieurs conteneurs physiques (ancien + nouveau, ou plusieurs replicas)
 * partagent le même `bozando.nodeId`. Le `ContainerStateTracker` résout l'état
 * PAR NŒUD avec une priorité ("running" domine "exited") : l'ancien conteneur qui
 * meurt ne fait plus basculer l'affichage tant qu'un nouveau tourne. Les events ne
 * déclenchent ni écriture DB ni émission socket si l'état résolu n'a pas changé.
 *
 * RECONNEXION : si le stream Docker se coupe (redémarrage du daemon, perte du
 * socket), on retente après un délai au lieu de laisser l'observer mourir en
 * silence pour toujours (c'était le cas avant — aucun `on("end"/"error")`).
 * Délais de retry croissants (5s -> 10s -> 30s -> 60s) pour éviter le re-loop
 * de souscription/re-snapshot en cas de daemon instable.
 * 
 * CLEANUP : activeClusters + reconnectTimers + streamsByCluster garantissent qu'un appel
 * à stopObserver() ferme tout proprement -aucun timer ni flux ne doit survivre à l'arret
 * du process. a appeler impérativement au shutdown.
 *
 * SNAPSHOT INITIAL : au démarrage, avant de s'abonner au flux d'events, on lit
 * une fois l'état réel de tous les conteneurs gérés (voir `syncInitialState`) pour
 * que les ressources déjà en cours avant ce démarrage soient immédiatement
 * correctes (sinon elles restent figées jusqu'à leur prochaine transition).
 * Les états du snapshot passent aussi par le tracker (déduplication).
 */

const retryDelays = [5_000, 10_000, 30_000, 60_000];
// On utilise une Map pour que chaque cluster ait son propre compteur de retry
const retryIndexByCluster = new Map<string, number>();

// Etat du cycle de vie
const activeClusters = new Set<string>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const streamsByCluster = new Map<
  string,
  NodeJS.ReadableStream & { destroy?: () => void }
>();

let tracker = new ContainerStateTracker();

/** Reset du tracker (hook de test uniquement — état mémoire de l'observer). */
export function resetTrackerForTests(): void {
  tracker = new ContainerStateTracker();
}

export async function startObserver(): Promise<void> {
  const clusters = await prisma.cluster.findMany({ select: { id: true } });
  for (const c of clusters) {
    void startObserverForCluster(c.id);
  }
}

/**
 * Arrete tous les observers proprement. Idempotent, sans effet si deje stoppe.
 * A appeler impérativement avant la sortie du process, sinon les timers de reconnexion
 * et les flux docker ouvert survivent au process.
 */

export function stopObserver(): void {
  activeClusters.clear();
  retryIndexByCluster.clear();

  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();

  for (const stream of streamsByCluster.values()) {
    if (typeof (stream as { destroy?: () => void }).destroy === "function") {
      (stream as { destroy: () => void }).destroy();
    }
  }

  streamsByCluster.clear();
}

/**
 * Planifions une reconnexion pour un cluster, avec le backoff progressif existant.
 * Centralisons ceux qui était dupliqué 3 fois dans l'ancienne version, Et vérifions "activeCluster"
 * pour ne jamais reprogrammer une reconnexion aprés un "stopObserver()" sinon un timer déja en vol
 * au moment du shutdown relancerait un observer sur un cluster arrête.
 */

function scheduleReconnect(clusterId: string): void {
  if (!activeClusters.has(clusterId)) return;

  const retryIndex = retryIndexByCluster.get(clusterId) ?? 0;
  const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
  retryIndexByCluster.set(clusterId, retryIndex + 1);

  const existing = reconnectTimers.get(clusterId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    reconnectTimers.delete(clusterId);
    void startObserverForCluster(clusterId);
  }, delay);
  reconnectTimers.set(clusterId, timer);
}

async function startObserverForCluster(clusterId: string): Promise<void> {
  if (!activeClusters.has(clusterId)) return;

  let engine: DockerEngineService;
  try {
    engine = await DockerEngineService.forCluster(clusterId);
  } catch {
    scheduleRetry(clusterId);
    return;
  }
  void syncInitialState(engine);

  const rawDocker = await getDockerForCluster(clusterId);


  rawDocker.getEvents(
    { filters: { label: [`${LabelKeys.managed}=true`], type: ["container"] } },
    (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        // Pas de socket / daemon pas encore prêt : on retente plus tard plutôt
        // que d'abandonner définitivement.
        scheduleReconnect(clusterId);
        return;
      }

      if (!activeClusters.has(clusterId)) {
        if (typeof (stream as { destroy?: () => void }).destroy === "function") {
          (stream as unknown as { destroy: () => void }).destroy();
        }
        return;
      }

      streamsByCluster.set(clusterId, stream);

      // Stream ouvert avec succès : on remet le compteur de backoff à zéro pour ce cluster.
      retryIndexByCluster.set(clusterId, 0);

      stream.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as {
              Type?: string;
              Action?: string;
              Actor?: { ID?: string; Attributes?: Record<string, string> };
            };
            void handleContainerEvent(evt, engine);
          } catch {
            // ligne partielle / non-JSON ignorée
          }
        }
      });

      // Le stream Docker peut se fermer (daemon restart, coupure du socket) sans
      // jamais rouvrir tout seul — sans ce ré-armement, l'observer reste mort
      // jusqu'au prochain restart du process API (c'était le bug initial).
      stream.on("end", () => {
        streamsByCluster.delete(clusterId);
        scheduleReconnect(clusterId);
      });
      stream.on("error", () => {
        streamsByCluster.delete(clusterId);
        scheduleReconnect(clusterId);
      });
    },
  );
}

/** Réarme l'observer d'un cluster avec backoff exponentiel borné. */
function scheduleRetry(clusterId: string) {
  const retryIndex = retryIndexByCluster.get(clusterId) ?? 0;
  const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
  retryIndexByCluster.set(clusterId, retryIndex + 1);
  setTimeout(() => startObserverForCluster(clusterId), delay);
}

/**
 * État dérivé d'un event "container". `Action` couvre directement la transition
 * réelle (pas besoin de creuser dans les attributs comme on le croyait pour
 * "task") : create/start = running, die/stop/kill/oom = état d'arrêt, destroy =
 * disparu. Vocabulaire aligné sur `ContainerInfo.State` (created/running/paused/
 * restarting/exited/dead) utilisé aussi par le snapshot initial.
 */
const CONTAINER_ACTION_TO_STATE: Record<string, ContainerState> = {
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
};

/**
 * Traitement unitaire d'un event Docker (agrégation + dédup par tracker).
 * Exporté pour les tests unitaires.
 */
export async function handleContainerEvent(
  evt: {
    Type?: string;
    Action?: string;
    Actor?: { ID?: string; Attributes?: Record<string, string> };
  },
  engine: DockerEngineService,
): Promise<void> {
  if (evt.Type !== "container") return;
  const attrs = evt.Actor?.Attributes ?? {};
  const nodeId = attrs[LabelKeys.nodeId];
  const projectId = attrs[LabelKeys.projectId];
  const action = evt.Action ?? "";
  const state = CONTAINER_ACTION_TO_STATE[action];
  const dockerId = evt.Actor?.ID;

  if (!nodeId || !state || !dockerId) return;

  // Agrégation par conteneur réel : emit/écritures UNIQUEMENT si l'état résolu
  // du nœud change (anti-flapping rolling update / replicas).
  const changed = tracker.apply(dockerId, nodeId, state);
  if (changed) {
    // Met à jour le reflet runtime (NON source de vérité).
    await prisma.node
      .update({ where: { id: nodeId }, data: { actualState: state } })
      .catch(() => {
        // nœud inconnu en base (ex: avant rebuild) — on émet quand même l'event live
      });

    await eventBus.emit("node.state", {
      projectId,
      nodeId,
      state,
      dockerStatus: `container:${action}`,
    });
  }

  scheduleReplicaRecount(nodeId, projectId, engine);
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
const REPLICA_DEBOUNCE_MS = 800;
const pendingRecount = new Map<string, NodeJS.Timeout>();

function scheduleReplicaRecount(
  nodeId: string,
  projectId: string | undefined,
  engine: DockerEngineService,
): void {
  const existing = pendingRecount.get(nodeId);
  if (existing) clearTimeout(existing);
  pendingRecount.set(
    nodeId,
    setTimeout(() => {
      pendingRecount.delete(nodeId);
      void recountReplicas(nodeId, projectId, engine);
    }, REPLICA_DEBOUNCE_MS),
  );
}

async function recountReplicas(
  nodeId: string,
  projectId: string | undefined,
  engine: DockerEngineService,
): Promise<void> {
  try {
    const serviceId = await engine.findServiceIdByNodeId(nodeId);
    if (!serviceId) {
      // Service disparu (destroy) : 0 replica live.
      await eventBus.emit("node.replicas", {
        projectId,
        nodeId,
        runningReplicas: 0,
      });
      return;
    }
    const metrics = await engine.getServiceMetrics(serviceId);
    await eventBus.emit("node.replicas", {
      projectId,
      nodeId,
      runningReplicas: metrics.runningReplicas,
    });
  } catch {
    // service/conteneur disparu entre l'event et la mesure — pas grave, le
    // prochain event (ou le snapshot suivant) corrigera.
  }
}

/**
 * Snapshot d'état initial au démarrage de l'observer (boot ou réarmement après
 * coupure du stream).
 *
 * Le flux d'events Docker ne signale que des TRANSITIONS — un conteneur déjà en
 * "running" avant ce démarrage ne déclenche aucun nouvel event tant que rien ne
 * change. Sans ce snapshot, son `actualState` restait figé sur sa valeur précédente
 * (souvent absente/périmée) malgré un état réel correct, alors que la page Santé
 * (qui interroge Docker en direct à chaque appel) affichait la bonne info — d'où le
 * décalage canvas/Santé constaté en test live.
 */
async function syncInitialState(engine: DockerEngineService): Promise<void> {
  let containers: Awaited<ReturnType<typeof engine.listManagedContainers>>;
  try {
    containers = await engine.listManagedContainers();
  } catch {
    // Daemon pas encore prêt au boot — le prochain cycle d'events s'en chargera.
    return;
  }

  for (const c of containers) {
    const labels = c.Labels ?? {};
    const nodeId = labels[LabelKeys.nodeId];
    const projectId = labels[LabelKeys.projectId];
    const state = c.State; // déjà au format created/running/paused/restarting/exited/dead
    const dockerId = c.Id;
    if (!nodeId || !state || !dockerId) continue;

    // Le même nodeId peut apparaître plusieurs fois (replicas) : le tracker
    // déduplique et renvoie uniquement un changement réel d'état résolu.
    const changed = tracker.apply(dockerId, nodeId, state as ContainerState);
    if (changed) {
      await prisma.node
        .update({ where: { id: nodeId }, data: { actualState: state } })
        .catch(() => {});

      await eventBus.emit("node.state", {
        projectId,
        nodeId,
        state,
        dockerStatus: `container:snapshot:${state}`,
      });
    }

    // Plusieurs conteneurs (replicas) peuvent partager le même nodeId : le debounce
    // de scheduleReplicaRecount déduplique déjà les appels redondants par nœud.
    scheduleReplicaRecount(nodeId, projectId, engine);
  }
}
