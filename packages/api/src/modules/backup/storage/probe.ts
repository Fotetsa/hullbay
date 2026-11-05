import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"
import type { StorageCapabilities, StorageProvider } from "./types"

/**
 * Probe de CAPACITÉ, pas de simple connexion.
 *
 * Séquence : list (auth + read) → put → stat → get + comparaison → hash →
 * delete. Un credential qui lit mais n'écrit pas est détecté ici, pas au
 * premier backup. L'objet de test vit sous `.probe/` et est toujours supprimé.
 */

export type ProbeCheckName =
  | "authenticate"
  | "list"
  | "write"
  | "stat"
  | "read"
  | "checksum"
  | "delete"
  | "move"

export interface ProbeCheck {
  name: ProbeCheckName
  ok: boolean
  error?: string
}

export interface StorageProbeResult {
  ok: boolean
  capabilities: StorageCapabilities
  checks: ProbeCheck[]
  errorCode?: string
}

const EMPTY: StorageCapabilities = {
  read: false,
  write: false,
  delete: false,
  move: false,
  checksum: false,
  atomicCommit: false,
  serverSideEncryption: false,
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function probeStorage(
  provider: StorageProvider,
  options: { prefix?: string } = {},
): Promise<StorageProbeResult> {
  const prefix = (options.prefix ?? ".probe").replace(/\/+$/, "")
  const key = `${prefix}/${randomUUID()}`
  const movedKey = `${key}.moved`
  const payload = Buffer.from(`hullbay-probe:${randomUUID()}`)
  const checks: ProbeCheck[] = []
  const capabilities: StorageCapabilities = { ...EMPTY }
  const record = (name: ProbeCheckName, ok: boolean, error?: unknown) => {
    checks.push({
      name,
      ok,
      error: error === undefined ? undefined : String(error),
    })
  }

  try {
    try {
      await provider.list(prefix)
      record("list", true)
      capabilities.read = true
    } catch (err) {
      record("list", false, err)
      return { ok: false, capabilities, checks, errorCode: "destination_unreachable" }
    }

    try {
      const put = await provider.put(key, payload, { size: payload.length })
      if (put.size !== payload.length) throw new Error("taille écrite incohérente")
      record("write", true)
      capabilities.write = true
    } catch (err) {
      record("write", false, err)
      // Lecture seule confirmée : inutile de tester la suite.
      return { ok: false, capabilities, checks, errorCode: "destination_read_only" }
    }

    try {
      const info = await provider.stat(key)
      if (!info || info.size !== payload.length) throw new Error("objet absent ou taille incorrecte")
      record("stat", true)
    } catch (err) {
      record("stat", false, err)
    }

    try {
      const body = await readAll(await provider.get(key))
      if (!body.equals(payload)) throw new Error("contenu relu différent de l'écrit")
      record("read", true)
      capabilities.read = true
    } catch (err) {
      record("read", false, err)
    }

    try {
      const hash = await provider.hash(key)
      if (hash) {
        record("checksum", true)
        capabilities.checksum = true
      } else {
        record("checksum", false, new Error("hash non supporté par le backend"))
      }
    } catch (err) {
      record("checksum", false, err)
    }

    try {
      const moved = await provider.move(key, movedKey)
      record("move", moved)
      capabilities.move = moved
      capabilities.atomicCommit = moved
    } catch (err) {
      record("move", false, err)
    }

    try {
      await provider.delete(movedKey)
      await provider.delete(key)
      record("delete", true)
      capabilities.delete = true
    } catch (err) {
      record("delete", false, err)
    }

    const ok =
      capabilities.read && capabilities.write && capabilities.delete
    return {
      ok,
      capabilities,
      checks,
      errorCode: ok ? undefined : "destination_capability_missing",
    }
  } finally {
    // Nettoyage best-effort : jamais d'objet de probe résiduel.
    await provider.delete(key).catch(() => undefined)
    await provider.delete(movedKey).catch(() => undefined)
  }
}
