import { describe, it, expect, vi } from "vitest"
import { runWithConcurrency } from "../concurrency"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("runWithConcurrency", () => {
  it("conserve l'ordre des résultats (par index d'entrée)", async () => {
    const delay = [30, 5, 20, 10]
    const { items } = await runWithConcurrency(delay, 4, async (ms) => {
      await sleep(ms)
      return ms
    })

    expect(items.map((it) => it.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"])
    expect(items.map((it) => (it.status === "fulfilled" ? it.value : null))).toEqual(delay)
    expect(items.map((it) => it.index)).toEqual([0, 1, 2, 3])
  })

  it("borne la concurrence à `limit` simultanés", async () => {
    let active = 0
    let peak = 0
    const { items } = await runWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(10)
      active -= 1
      return true
    })

    expect(peak).toBe(2)
    expect(items).toHaveLength(5)
  })

  it("isole l'échec d'un item (allSettled) : ne rejette pas la boucle", async () => {
    const { items } = await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom")
      return n
    })

    expect(items[1]!.status).toBe("rejected")
    expect(items[0]!.status).toBe("fulfilled")
    expect(items[2]!.status).toBe("fulfilled")
  })

  it("retourne vide si aucun item", async () => {
    const { items, totalMs } = await runWithConcurrency([], 4, async () => 1)
    expect(items).toEqual([])
    expect(totalMs).toBe(0)
  })

  it("fournit durationMs par item et totalMs > 0", async () => {
    const { items, totalMs } = await runWithConcurrency([1, 2], 2, async () => {
      await sleep(5)
      return 1
    })

    expect(totalMs).toBeGreaterThan(0)
    for (const it of items) {
      expect(it.durationMs).toBeGreaterThan(0)
    }
  })

  it("accepte une function sync (pas de Promise requerue)", async () => {
    const { items } = await runWithConcurrency([1, 2, 3], 2, (n) => n * 2)
    expect(items.map((it) => (it.status === "fulfilled" ? it.value : null))).toEqual([2, 4, 6])
  })

  it("borne la limite : limit <= 0 → exécute quand même (1 worker)", async () => {
    const fn = vi.fn(async () => 1)
    const { items } = await runWithConcurrency([1, 2], 0, fn)
    expect(items).toHaveLength(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})