import { describe, expect, it } from "vitest"
import { Semaphore } from "../concurrency"

describe("Semaphore (politique de concurrence #16)", () => {
  it("borne le nombre d'acquisitions simultanées et libère les suivantes", async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    await sem.acquire()

    let thirdAcquired = false
    const third = sem.acquire().then(() => {
      thirdAcquired = true
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(thirdAcquired).toBe(false)

    sem.release()
    await third
    expect(thirdAcquired).toBe(true)

    sem.release()
    sem.release()
  })
})
