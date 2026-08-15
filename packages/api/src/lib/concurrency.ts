/**
 * Concurrence bornée pour les opérations qui itèrent sur tous les clusters.
 *
 * Contexte (issue #78) : plusieurs jobs/endpoints itéraient séquentiellement
 * (await dans un for..of) sur la liste des clusters, chaque itération faisant
 * des appels réseau (tunnel SSH / Docker API). Latence = Σ des latences par
 * cluster. Ce module borne la concurrence (Promise.allSettled) pour paralléliser
 * sans saturer les backends (tunnels, daemons).
 *
 * Le comportement reproduit Promise.allSettled : un échec sur un cluster
 * n'aborte jamais le reste — les callers décident de la résolution.
 */

/** Limite par défaut d'opérations cluster-wide simultanées. */
const DEFAULT_CLUSTER_CONCURRENCY = 4

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Concurrence cluster-wide, configurable via HULLBAY_CLUSTER_CONCURRENCY. */
export const CLUSTER_CONCURRENCY = parsePositiveInt(
  process.env.HULLBAY_CLUSTER_CONCURRENCY,
  DEFAULT_CLUSTER_CONCURRENCY,
)

export type SettledItem<T> =
  | { index: number; status: "fulfilled"; value: T; durationMs: number }
  | { index: number; status: "rejected"; reason: unknown; durationMs: number }

export type ConcurrencyResult<T> = {
  /** Résultats alignés sur l'ordre d'entrée (par index), un par item. */
  items: SettledItem<T>[]
  /** Temps total de la boucle (concurrence incluse). */
  totalMs: number
}

/**
 * Exécute `fn` sur chaque item avec au plus `limit` appels simultanés.
 * Jamais rejette : un échec d'item est capturé (semantics allSettled).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<ConcurrencyResult<R>> {
  const start = performance.now()
  if (items.length === 0) return { items: [], totalMs: 0 }

  const safeLimit = Math.max(1, Math.floor(limit))
  const settled: SettledItem<R>[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      const t0 = performance.now()
      try {
        const value = await fn(items[index]!, index)
        settled[index] = {
          index,
          status: "fulfilled",
          value,
          durationMs: performance.now() - t0,
        }
      } catch (reason) {
        settled[index] = {
          index,
          status: "rejected",
          reason,
          durationMs: performance.now() - t0,
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(safeLimit, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return { items: settled, totalMs: performance.now() - start }
}
