import { spawn } from "node:child_process"
import { Readable } from "node:stream"
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
import { StorageProviderError, UNPROBED_CAPABILITIES } from "./types"
import { scrubSecrets } from "./remote-string"

export { StorageProviderError }

/**
 * Implémentation `StorageProvider` au-dessus du binaire rclone.
 *
 * Ce fichier est le SEUL du dépôt autorisé à invoquer rclone. La remote-string
 * est construite par `remote-string.ts` (également seul point d'assemblage des
 * credentials) et n'apparaît jamais dans un message d'erreur : toute sortie est
 * passée par `scrubSecrets`.
 */

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface RcloneProviderOptions {
  binary?: string
  timeoutMs?: number
  /**
   * Matrice observée par le probe de la destination. Sans probe, aucune
   * capacité optionnelle n'est revendiquée.
   */
  capabilities?: StorageCapabilities | null
}

export class RcloneStorageProvider implements StorageProvider {
  readonly id = "rclone"
  private readonly binary: string
  private readonly timeoutMs: number
  private readonly declaredCapabilities: StorageCapabilities | null

  constructor(
    /** Remote-string de base, sans slash final. Contient des credentials. */
    private readonly remote: string,
    options: RcloneProviderOptions = {},
  ) {
    this.binary = options.binary ?? "rclone"
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.declaredCapabilities = options.capabilities ?? null
  }

  capabilities(): StorageCapabilities {
    // Vérité = dernier probe. Le fallback copy-verify-delete ne rend pas le
    // backend "checksum" ou "atomicCommit" pour autant.
    return this.declaredCapabilities ?? UNPROBED_CAPABILITIES
  }

  private url(key: string): string {
    const clean = key.replace(/^\/+/, "")
    return clean.length > 0 ? `${this.remote}/${clean}` : this.remote
  }

  private run(args: string[], stdin?: Readable | Buffer): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let settled = false

      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        fail(new StorageProviderError("délai dépassé", "timeout"))
      }, this.timeoutMs)

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }

      child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
      child.on("error", (error) =>
        fail(
          new StorageProviderError(
            scrubSecrets(`rclone indisponible : ${error.message}`),
            "binary_missing",
          ),
        ),
      )
      child.on("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          code: code ?? 1,
        })
      })

      if (stdin === undefined) {
        child.stdin.end()
      } else if (Buffer.isBuffer(stdin)) {
        child.stdin.end(stdin)
      } else {
        stdin.pipe(child.stdin)
      }
    })
  }

  private async runOrThrow(args: string[], stdin?: Readable | Buffer): Promise<RunResult> {
    const result = await this.run(args, stdin)
    if (result.code !== 0) {
      throw new StorageProviderError(
        scrubSecrets(result.stderr.trim() || `rclone exit ${result.code}`),
        "rclone_failed",
      )
    }
    return result
  }

  /**
   * Petit objet (manifest, checksum) ou flux déjà borné. Le payload de backup
   * n'emprunte pas ce chemin : il est streamé par le producteur via
   * `StagingSink`.
   */
  async put(
    key: string,
    data: Readable | Buffer,
    opts?: PutOptions,
  ): Promise<PutResult> {
    await this.runOrThrow(["rcat", this.url(key)], data)
    const info = await this.stat(key)
    return { key, size: info?.size ?? opts?.size ?? 0 }
  }

  async get(key: string): Promise<Readable> {
    const child = spawn(this.binary, ["cat", this.url(key)], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    return child.stdout
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const result = await this.run(["lsjson", "--stat", this.url(key)])
    if (result.code !== 0) return null
    try {
      const parsed = JSON.parse(result.stdout) as {
        Size?: number
        ModTime?: string
        IsDir?: boolean
      }
      if (parsed.IsDir) return null
      return {
        key,
        size: parsed.Size ?? 0,
        modifiedAt: parsed.ModTime,
      }
    } catch {
      return null
    }
  }

  async list(prefix: string): Promise<ObjectStat[]> {
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "")
    const target = cleanPrefix.length > 0 ? this.url(cleanPrefix) : this.remote
    const result = await this.run(["lsjson", "-R", target])
    if (result.code !== 0) {
      throw new StorageProviderError(
        scrubSecrets(result.stderr.trim() || "list impossible"),
        "list_failed",
      )
    }
    const parsed = JSON.parse(result.stdout || "[]") as {
      Path?: string
      Name?: string
      Size?: number
      ModTime?: string
      IsDir?: boolean
    }[]
    return parsed
      .filter((entry) => !entry.IsDir)
      .map((entry) => {
        const relative = entry.Path ?? entry.Name ?? ""
        // `rclone lsjson -R` renvoie des chemins RELATIFS au préfixe listé.
        // Le contrat exige des clés complètes, directement acceptées par
        // delete()/get()/stat() — sinon le nettoyage supprime au mauvais endroit.
        const key = cleanPrefix ? `${cleanPrefix}/${relative}` : relative
        return {
          key: key.replace(/\/+$/, ""),
          size: entry.Size ?? 0,
          modifiedAt: entry.ModTime,
        }
      })
  }

  async delete(key: string): Promise<void> {
    await this.runOrThrow(["deletefile", this.url(key)])
  }

  async move(from: string, to: string): Promise<boolean> {
    const result = await this.run(["moveto", this.url(from), this.url(to)])
    if (result.code === 0) return true
    // Certains backends n'exposent pas de rename : l'appelant dégrade en
    // copy+verify+delete. On ne lève donc pas, on signale.
    if (/not support|unsupported|operation not permitted/i.test(result.stderr)) {
      return false
    }
    throw new StorageProviderError(
      scrubSecrets(result.stderr.trim() || "move impossible"),
      "move_failed",
    )
  }

  async hash(key: string, algorithm: HashAlgorithm = "sha256"): Promise<string | null> {
    const result = await this.run(["hashsum", algorithm, this.url(key)])
    if (result.code !== 0) return null
    const value = result.stdout.trim().split(/\s+/)[0] ?? ""
    return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null
  }

  async commitPayload(input: CommitPayloadInput): Promise<CommitMode> {
    const { stagingKey, finalKey, expectedChecksum, expectedSizeBytes } = input

    // La taille est toujours vérifiée : référence quand le backend n'a pas de
    // checksum natif (downgrade déjà décidé par le lifecycle).
    const staging = await this.stat(stagingKey)
    if (!staging || staging.size !== expectedSizeBytes) {
      throw new StorageProviderError("taille distante différente", "verify_failed")
    }
    const remoteHash = await this.hash(stagingKey)
    if (remoteHash && remoteHash !== expectedChecksum) {
      throw new StorageProviderError("checksum distant différent", "checksum_mismatch")
    }
    if (await this.move(stagingKey, finalKey)) return "atomic-rename"

    // Backend sans rename natif : copy → verify (checksum si dispo, sinon
    // taille) → delete.
    const data = await this.get(stagingKey)
    await this.put(finalKey, data)
    const copiedHash = await this.hash(finalKey)
    if (copiedHash) {
      if (copiedHash !== expectedChecksum) {
        await this.delete(finalKey).catch(() => undefined)
        throw new StorageProviderError("copie distante non vérifiée", "commit_failed")
      }
    } else {
      const copied = await this.stat(finalKey)
      if (!copied || copied.size !== expectedSizeBytes) {
        await this.delete(finalKey).catch(() => undefined)
        throw new StorageProviderError("copie distante non vérifiée (taille)", "commit_failed")
      }
    }
    await this.delete(stagingKey)
    return "copy-verify-delete"
  }
}
