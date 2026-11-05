import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type {
  CommitMode,
  CommitPayloadInput,
  HashAlgorithm,
  ObjectStat,
  PutOptions,
  PutResult,
  StorageCapabilities,
  StorageProvider,
} from "./types"

/**
 * Backend local (système de fichiers).
 *
 * Deux usages : tests de conformité du contrat `StorageProvider`, et
 * développement sans backend distant. Il n'est jamais utilisé pour un backup
 * de production (le task Swarm n'a pas de volume persistant).
 */
export class LocalStorageProvider implements StorageProvider {
  readonly id = "local"

  constructor(private readonly root: string) {}

  capabilities(): StorageCapabilities {
    return {
      read: true,
      write: true,
      delete: true,
      move: true,
      checksum: true,
      atomicCommit: true,
      serverSideEncryption: false,
    }
  }

  /** Empêche toute évasion hors de la racine (clé contrôlée par l'appelant). */
  private resolveKey(key: string): string {
    const full = path.resolve(this.root, key)
    const root = path.resolve(this.root)
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error("clé de stockage hors périmètre")
    }
    return full
  }

  async put(
    key: string,
    data: Readable | Buffer,
    _opts?: PutOptions,
  ): Promise<PutResult> {
    const target = this.resolveKey(key)
    await mkdir(path.dirname(target), { recursive: true })
    if (Buffer.isBuffer(data)) {
      await pipeline(Readable.from(data), createWriteStream(target))
    } else {
      await pipeline(data, createWriteStream(target))
    }
    const info = await stat(target)
    return { key, size: info.size, checksum: await this.hash(key) ?? undefined }
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.resolveKey(key))
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const info = await stat(this.resolveKey(key))
      if (!info.isFile()) return null
      return {
        key,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      }
    } catch {
      return null
    }
  }

  async list(prefix: string): Promise<ObjectStat[]> {
    const base = this.resolveKey(prefix)
    const out: ObjectStat[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          const info = await stat(full)
          out.push({
            key: path.relative(path.resolve(this.root), full).split(path.sep).join("/"),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          })
        }
      }
    }
    await walk(base)
    return out
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    const src = this.resolveKey(from)
    const dst = this.resolveKey(to)
    await mkdir(path.dirname(dst), { recursive: true })
    try {
      await rename(src, dst)
      return true
    } catch {
      // Systèmes de fichiers différents : copy + verify + delete.
      const hash = await this.hash(from)
      await this.put(to, createReadStream(src))
      if (hash && (await this.hash(to)) !== hash) {
        await rm(dst, { force: true })
        throw new Error("copie non vérifiée")
      }
      await unlink(src)
      return true
    }
  }

  async hash(key: string, algorithm: HashAlgorithm = "sha256"): Promise<string | null> {
    const digest = createHash(algorithm)
    try {
      for await (const chunk of createReadStream(this.resolveKey(key))) {
        digest.update(chunk as Buffer)
      }
    } catch {
      return null
    }
    return digest.digest("hex")
  }

  async commitPayload(input: CommitPayloadInput): Promise<CommitMode> {
    const { stagingKey, finalKey, expectedChecksum, expectedSizeBytes } = input
    const staging = await this.stat(stagingKey)
    if (!staging || staging.size !== expectedSizeBytes) {
      throw new Error("taille distante différente")
    }
    const remoteHash = await this.hash(stagingKey)
    if (remoteHash && remoteHash !== expectedChecksum) {
      throw new Error("checksum distant différent")
    }
    if (await this.move(stagingKey, finalKey)) return "atomic-rename"
    // Fallback (jamais atteint en local, mais conforme au contrat).
    const data = await this.get(stagingKey)
    await this.put(finalKey, data)
    const copiedHash = await this.hash(finalKey)
    if (copiedHash) {
      if (copiedHash !== expectedChecksum) {
        await this.delete(finalKey).catch(() => undefined)
        throw new Error("copie non vérifiée")
      }
    } else {
      const copied = await this.stat(finalKey)
      if (!copied || copied.size !== expectedSizeBytes) {
        await this.delete(finalKey).catch(() => undefined)
        throw new Error("copie non vérifiée (taille)")
      }
    }
    await this.delete(stagingKey)
    return "copy-verify-delete"
  }
}
