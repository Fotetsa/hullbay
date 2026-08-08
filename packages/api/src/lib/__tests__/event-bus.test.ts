import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

// Fake Redis : pub/sub in-memory, l'écho de sa propre publication est simulé
// (comportement réel de Redis pub/sub : un abonné reçoit aussi ses propres emit).
type RedisMessage = { channel: string; message: string }
const subscribers = new Set<(channel: string, message: string) => void>()

vi.mock("ioredis", () => {
  class FakeRedis {
    constructor(public url: string) {
      // Inutile pour le test — la redelivery est simulée dans publish().
    }
    subscribe() {}
    on(_event: string, cb: (channel: string, message: string) => void) {
      void _event
      subscribers.add(cb)
      return this
    }
    async publish(channel: string, message: string) {
      // Simule Redis : DELIVRE AUSSI la publication à son propre abonné.
      for (const cb of subscribers) {
        try {
          cb(channel, message)
        } catch {
          // l'echo part en async : on laisse les handlers gérer
        }
      }
      return 1
    }
    async quit() {
      return "OK"
    }
  }
  return { Redis: FakeRedis }
})

import { EventBus } from "../event-bus"

describe("EventBus — anti self-echo", () => {
  let bus: EventBus
  const spy = vi.fn()

  beforeAll(() => {
    subscribers.clear()
  })

  afterAll(async () => {
    await bus.close()
  })

  it("n'émet pas l'echo de sa propre publication Redis", async () => {
    bus = new EventBus("redis://test:6379")
    bus.on("*", spy)

    await bus.emit("node.state", { nodeId: "n1", state: "running" })

    // Avec la redelivery, l'ancien code déclenchait spy 2× ; avec l'anti-echo : 1×.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "node.state", data: { nodeId: "n1", state: "running" } })
    )
  })

  it("on(name) reçoit aussi l'event sans doublon", async () => {
    const namedSpy = vi.fn()
    bus.on("node.state", namedSpy)

    await bus.emit("node.state", { nodeId: "n1", state: "created" })

    expect(namedSpy).toHaveBeenCalledTimes(1)
  })

  it("ne laisse pas fuiter _sessionId dans data", async () => {
    const dataSpy = vi.fn()
    bus.on("x", (e) => dataSpy(e))

    await bus.emit("x", { a: 1 })

    const received = dataSpy.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(received.data).toEqual({ a: 1 })
    expect(received.data).not.toHaveProperty("_sessionId")
  })
})