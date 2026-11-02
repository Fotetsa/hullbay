import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LocalStorageProvider } from "../local-provider"
import { probeStorage } from "../probe"
import type { StorageProvider } from "../types"

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe("LocalStorageProvider", () => {
  let root: string
  let provider: LocalStorageProvider

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hullbay-backup-"))
    provider = new LocalStorageProvider(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("écrit, relit et calcule le checksum", async () => {
    const payload = Buffer.from("hello backup")
    const result = await provider.put("a/b/payload.sql.gz", payload)
    expect(result.size).toBe(payload.length)
    expect(await readAll(await provider.get("a/b/payload.sql.gz"))).toEqual(payload)
    expect(await provider.hash("a/b/payload.sql.gz")).toBe(
      createHash("sha256").update(payload).digest("hex"),
    )
  })

  it("liste récursivement sous un préfixe", async () => {
    await provider.put("p/one", Buffer.from("1"))
    await provider.put("p/two", Buffer.from("22"))
    await provider.put("other", Buffer.from("x"))
    const listed = await provider.list("p")
    expect(listed.map((o) => o.key).sort()).toEqual(["p/one", "p/two"])
  })

  it("déplace un objet", async () => {
    await provider.put("from", Buffer.from("data"))
    expect(await provider.move("from", "to")).toBe(true)
    expect(await provider.stat("from")).toBeNull()
    expect((await readAll(await provider.get("to"))).toString()).toBe("data")
  })

  it("supprime sans échouer sur une clé absente", async () => {
    await expect(provider.delete("absent")).resolves.toBeUndefined()
  })

  it("refuse une clé qui sort de la racine", async () => {
    await expect(provider.put("../evasion", Buffer.from("x"))).rejects.toThrow(
      /hors périmètre/,
    )
  })
})

describe("probeStorage", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hullbay-probe-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("valide toutes les capacités d'un backend sain et ne laisse rien", async () => {
    const provider = new LocalStorageProvider(root)
    const result = await probeStorage(provider)

    expect(result.ok).toBe(true)
    expect(result.capabilities).toMatchObject({
      read: true,
      write: true,
      delete: true,
      move: true,
      checksum: true,
    })
    expect(result.checks.every((c) => c.ok)).toBe(true)
    const leftovers = await readdir(path.join(root, ".probe")).catch(() => [] as string[])
    expect(leftovers).toEqual([])
  })

  it("détecte un credential en lecture seule", async () => {
    const local = new LocalStorageProvider(root)
    const readOnly: StorageProvider = {
      id: "read-only",
      capabilities: () => local.capabilities(),
      put: async () => {
        throw new Error("403 Forbidden")
      },
      get: (key) => local.get(key),
      stat: (key) => local.stat(key),
      list: (prefix) => local.list(prefix),
      delete: (key) => local.delete(key),
      move: (from, to) => local.move(from, to),
      hash: (key) => local.hash(key),
      commitPayload: (input) => local.commitPayload(input),
    }

    const result = await probeStorage(readOnly)
    expect(result.ok).toBe(false)
    expect(result.capabilities.write).toBe(false)
    expect(result.errorCode).toBe("destination_read_only")
    expect(result.checks.find((c) => c.name === "write")?.ok).toBe(false)
  })

  it("détecte une destination injoignable", async () => {
    const unreachable: StorageProvider = {
      id: "unreachable",
      capabilities: () => new LocalStorageProvider(root).capabilities(),
      put: async () => {
        throw new Error("ne doit pas être appelé")
      },
      get: async () => {
        throw new Error("ne doit pas être appelé")
      },
      stat: async () => null,
      list: async () => {
        throw new Error("ECONNREFUSED")
      },
      delete: async () => undefined,
      move: async () => false,
      hash: async () => null,
      commitPayload: async () => "atomic-rename",
    }

    const result = await probeStorage(unreachable)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("destination_unreachable")
    expect(result.checks).toHaveLength(1)
  })

  it("signale l'absence de checksum natif", async () => {
    const local = new LocalStorageProvider(root)
    const noHash: StorageProvider = {
      id: "no-hash",
      capabilities: () => local.capabilities(),
      put: (key, data, opts) => local.put(key, data, opts),
      get: (key) => local.get(key),
      stat: (key) => local.stat(key),
      list: (prefix) => local.list(prefix),
      delete: (key) => local.delete(key),
      move: (from, to) => local.move(from, to),
      hash: async () => null,
      commitPayload: (input) => local.commitPayload(input),
    }

    const result = await probeStorage(noHash)
    expect(result.ok).toBe(true)
    expect(result.capabilities.checksum).toBe(false)
    expect(result.checks.find((c) => c.name === "checksum")?.ok).toBe(false)
  })
})
