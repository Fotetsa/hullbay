import { EventEmitter } from "node:events"
import { Redis } from "ioredis"

/**
 * Mini event-bus façon Medusa : émettre/écouter des events métier découplés.
 *
 * - Local : EventEmitter pour les subscribers in-process (workflows -> subscribers).
 * - Broadcast : Redis pub/sub pour pousser des events vers les sockets WS
 *   (calque du pattern chat-websocket.ts du backend : canal Redis -> io.emit).
 *
 * Les events Docker (start/die/...) et les events de workflow (deploy.finished...)
 * passent par ici, puis le loader websocket les relaie au canvas.
 */

export type OpsEvent = {
  name: string
  data: Record<string, unknown>
}

export type EventHandler = (event: OpsEvent) => void | Promise<void>

const REDIS_CHANNEL = "hullbay:events"

export class EventBus {
  private emitter = new EventEmitter()
  private pub: Redis | null = null
  private sub: Redis | null = null

  constructor(redisUrl?: string) {
    this.emitter.setMaxListeners(100)
    const url = redisUrl || process.env.REDIS_URL
    if (url) {
      this.pub = new Redis(url)
      this.sub = new Redis(url)
      this.sub.subscribe(REDIS_CHANNEL)
      this.sub.on("message", (_channel, message) => {
        try {
          const event = JSON.parse(message) as OpsEvent
          // Rejoue localement les events venus d'autres process (broadcast).
          this.emitter.emit(event.name, event)
          this.emitter.emit("*", event)
        } catch {
          // message invalide ignoré
        }
      })
    }
  }

  /** Émet un event : in-process + broadcast Redis (si dispo). */
  async emit(name: string, data: Record<string, unknown> = {}): Promise<void> {
    const event: OpsEvent = { name, data }
    this.emitter.emit(name, event)
    this.emitter.emit("*", event)
    if (this.pub) {
      await this.pub.publish(REDIS_CHANNEL, JSON.stringify(event))
    }
  }

  /** Abonne un handler à un event nommé (ou "*" pour tous). */
  on(name: string, handler: EventHandler): () => void {
    this.emitter.on(name, handler)
    return () => this.emitter.off(name, handler)
  }

  async close(): Promise<void> {
    await this.pub?.quit()
    await this.sub?.quit()
  }
}

/** Singleton partagé sur le process. */
export const eventBus = new EventBus()
