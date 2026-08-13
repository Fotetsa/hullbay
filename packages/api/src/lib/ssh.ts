import { Client } from "ssh2"
import { createHash } from "node:crypto"
import type { Duplex } from "node:stream";

/**
 * Wrapper SSH (ssh2) pour le provisioning one-shot des serveurs.
 *
 * SÉCURITÉ : la clé/password fournis vivent EN MÉMOIRE le temps de la session,
 * ne sont JAMAIS écrits sur disque ni loggés. TOFU sur la host key (on capture
 * l'empreinte à la 1ère connexion ; si une empreinte connue est fournie et qu'elle
 * diffère → refus anti-MITM).
 */

export type SshCredential =
  | { type: "key"; privateKey: string; passphrase?: string }
  | { type: "password"; password: string }

export interface SshExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface SshConnectOptions {
  host: string
  port?: number
  user?: string
  credential: SshCredential
  /** Empreinte attendue (sha256 base64). Si fournie et différente → refus. */
  knownHostKeyFp?: string
  /** Callback à l'obtention de l'empreinte (pour la persister en TOFU). */
  onHostKey?: (fp: string) => void
}

export class SshSession {
  private client: Client
  private constructor(client: Client) {
    this.client = client
  }

  static connect(opts: SshConnectOptions): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      client
        .on("ready", () => resolve(new SshSession(client)))
        .on("error", (err) => reject(new Error(`SSH: ${err.message}`)))
        .connect({
          host: opts.host,
          port: opts.port ?? 22,
          username: opts.user ?? "root",
          ...(opts.credential.type === "key"
            ? {
                privateKey: opts.credential.privateKey,
                passphrase: opts.credential.passphrase,
              }
            : { password: opts.credential.password }),
          // TOFU : on inspecte la host key avant d'accepter.
          hostVerifier: (key: Buffer) => {
            const fp = "sha256:" + createHash("sha256").update(key).digest("base64")
            opts.onHostKey?.(fp)
            if (opts.knownHostKeyFp && opts.knownHostKeyFp !== fp) {
              return false // empreinte changée → refus
            }
            return true
          },
        })
    })
  }

  /** Exécute une commande, agrège stdout/stderr, renvoie le code de sortie. */
  exec(command: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ""
        let stderr = ""
        stream
          .on("close", (code: number) => resolve({ stdout, stderr, code: code ?? 0 }))
          .on("data", (d: Buffer) => (stdout += d.toString()))
          .stderr.on("data", (d: Buffer) => (stderr += d.toString()))
      })
    })
  }

  /**
   *  Ouverture d'un canal "direct-tcpip" vers dtsHost:dstHost:dstPort depuis le serveur distant
   * @param dstHost 
   * @param dstPort 
   * @returns 
   */
  forwardOut(dstHost: string, dstPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut("127.0.0.1", 0, dstHost, dstPort, (err, Stream) => {
        if (err) return reject(new Error(`SSH forwardOut: ${err.message}`))
        resolve(Stream)
      })
    })
  }
  /**
   * Ajoute une clé publique aux authorized_keys du user distant (idempotent :
   * n'ajoute pas si déjà présente). Sécurité : la clé publique n'est pas un secret.
   */
  async appendAuthorizedKey(publicKey: string): Promise<void> {
    const cmd =
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `chmod 600 ~/.ssh/authorized_keys && ` +
      `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || ` +
      `echo ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`
    const res = await this.exec(cmd)
    if (res.code !== 0) throw new Error(`authorized_keys: ${res.stderr}`)
  }

  dispose(): void {
    this.client.end()
  }
}

/** Échappe une valeur pour l'insérer en argument shell entre simples quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
