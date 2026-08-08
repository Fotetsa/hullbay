import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
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
 *
 * ANTI SELF-ECHO : ce process s'abonne au même canal qu'il publie. Redis redélivre
 * SES PROPRES publications à son abonné — sans garde, chaque event était ré-émis
 * une seconde fois localement (doublon de messages WebSocket, doublon de listeners).
 * Chaque instance porte un sessionId unique, injecté dans le payload publié ; les
 * messages portant SON propre sessionId sont ignorés en réception.
 */

export type OpsEvent = {
  name: string
  data: Record<string, unknown>
  /** Marqueur de l'instance émettrice (anti self-echo Redis pub/sub). */
  _sessionId?: string
}

export type EventHandler = (event: OpsEvent) => void | Promise<void>

const REDIS_CHANNEL = "hullbay:events"

export class EventBus {
  private emitter = new EventEmitter()
  private pub: Redis | null = null
  private sub: Redis | null = null
  private readonly sessionId = randomUUID()

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
          // Ignore notre propre publication (Redis la redélivre à notre abonné).
          if (event._sessionId === this.sessionId) return
          // Rejoue localement les events venus d'autres process (broadcast).
          this.emitter.emit(event.name, event)
          this.emitter.emit("*", event)
        } catch {
          // message invalide ignoré
        }
      })
    }
  }

  /**
   * Émet un event : in-process + broadcast Redis (si dispo). Marque le payload
   * du sessionId de l'émetteur pour que les autres process (ou nous-mêmes)
   * puissent filtrer l'écho.
   */
  async emit(name: string, data: Record<string, unknown> = {}): Promise<void> {
    const event: OpsEvent = { name, data, _sessionId: this.sessionId }
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
