import { useEffect, useRef, useState } from "react"
import type { Socket } from "socket.io-client"
import { createOpsSocket } from "./socket"
import type { UpdateStepRec } from "./api"

/**
 * Écoute les events de mise à jour de l'instance (`update.step`,
 * `update.progress`, `update.done`, `update.error`) — émis par le backend sur
 * l'eventBus global puis relayés en broadcast par le socket. Pas de room : les
 * events updates concernent toute l'instance.
 *
 * Même pattern que useOpsSocket : callbacks dans des refs, connexion stable au
 * montage. `connected` indique l'état du lien (live / reconnexion…).
 */
export type UpdateSocketHandlers = {
  onStep?: (payload: { updateId: string; name: string; status: string; error?: string }) => void
  onProgress?: (payload: { updateId: string; component: string; version: string }) => void
  onDone?: (payload: {
    updateId: string
    status: string
    fromVersion: string | null
    toVersion: string | null
  }) => void
  onError?: (payload: { updateId: string; error: string }) => void
}

export function useUpdateSocket(handlers: UpdateSocketHandlers) {
  const [connected, setConnected] = useState(false)
  const refs = useRef(handlers)
  refs.current = handlers

  useEffect(() => {
    const socket: Socket = createOpsSocket()
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    socket.on("connect", onConnect)
    socket.on("disconnect", onDisconnect)
    socket.on("update.step", (p) => refs.current.onStep?.(p))
    socket.on("update.progress", (p) => refs.current.onProgress?.(p))
    socket.on("update.done", (p) => refs.current.onDone?.(p))
    socket.on("update.error", (p) => refs.current.onError?.(p))
    if (socket.connected) onConnect()

    return () => {
      socket.off("connect", onConnect)
      socket.off("disconnect", onDisconnect)
      socket.off("update.step")
      socket.off("update.progress")
      socket.off("update.done")
      socket.off("update.error")
      socket.disconnect()
    }
  }, [])

  return { connected }
}

/** Dernier message d'une étape en échec (pour l'UI timeline). */
export function stepError(step: UpdateStepRec | undefined): string | undefined {
  return step?.status === "failed" ? step.error : undefined
}