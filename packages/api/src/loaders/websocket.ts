import type { Server as HttpServer } from "node:http"
import { Server as SocketIOServer } from "socket.io"
import { eventBus } from "../lib/event-bus"
import { DockerEngineService } from "../modules/docker-engine/service"
import { authService } from "../modules/auth/service"

/**
 * Loader WebSocket (socket.io) — calque le pattern backend/src/loaders/chat-websocket.ts.
 *
 * - Auth JWT obligatoire au handshake (le canvas n'est jamais accessible anonyme).
 * - Rooms par projet : `project:<id>` → les events live (node.state, deploy...) y sont diffusés.
 * - Stream de logs d'un conteneur à la demande (subscribe:logs).
 *
 * Les events ops (émis par observer / workflows via eventBus) sont relayés ici
 * aux sockets abonnés au projet concerné.
 */
export function attachWebSocket(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/ws",
    cors: {
      origin: (process.env.WEB_ORIGIN || "http://localhost:5273").split(","),
      credentials: true,
    },
    transports: ["polling", "websocket"],
  })

  // Auth au handshake : via authService.verifyToken qui exige l'audience SESSION
  // (rejette tout token mfa-pending — pas de bypass MFA par le WebSocket).
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (!token) return next(new Error("AUTH_FAILED"))
    try {
      const decoded = authService.verifyToken(token)
      socket.data.userId = decoded.sub
      socket.data.role = decoded.role
      next()
    } catch {
      next(new Error("AUTH_FAILED"))
    }
  })

  io.on("connection", (socket) => {
    // Rejoindre la room d'un projet (pour recevoir ses events live).
    socket.on("join:project", (projectId: string) => {
      if (typeof projectId === "string") socket.join(`project:${projectId}`)
    })
    socket.on("leave:project", (projectId: string) => {
      if (typeof projectId === "string") socket.leave(`project:${projectId}`)
    })

    // Stream de logs d'un conteneur à la demande.
    let logStream: NodeJS.ReadableStream | null = null
    socket.on("subscribe:logs", async (payload: { clusterId: string; containerId: string }) => {
      if (typeof payload?.containerId !== "string" || typeof payload?.clusterId !== "string") return
      try {
        const docker = await DockerEngineService.forCluster(payload.clusterId)
        logStream = await docker.streamLogs(payload.containerId)
        logStream.on("data", (chunk: Buffer) => {
          socket.emit("log", { containerId: payload.containerId, line: chunk.toString("utf8") })
        })
      } catch (err) {
        socket.emit("error", {
          message: err instanceof Error ? err.message : "log stream failed",
        })
      }
    })
    socket.on("unsubscribe:logs", () => {
      ;(logStream as unknown as { destroy?: () => void })?.destroy?.()
      logStream = null
    })
    socket.on("disconnect", () => {
      ;(logStream as unknown as { destroy?: () => void })?.destroy?.()
      logStream = null
    })
  })

  // Relai des events ops -> sockets du projet concerné.
  eventBus.on("*", (event) => {
    const projectId = event.data?.projectId
    if (typeof projectId === "string") {
      io.to(`project:${projectId}`).emit(event.name, event.data)
    } else {
      io.emit(event.name, event.data)
    }
  })

  return io
}
