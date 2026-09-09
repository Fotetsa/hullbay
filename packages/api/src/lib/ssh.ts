import { QueryClient } from '@tanstack/react-query';
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

  /**
   * Délai maximum, en millisecondes, pour etablir la connexion. Sans ça, un hôte injoignable
   * (mauvaise IP, pare-feu qui droppe silencieusement les paquets plutôt que de renvoyerun refus
   * explicite) bloque le workflow de provisioning indéfiniment, et le serveur reste coincé en 
   * "provisioning" pour toujours, sans aucun moyen automatique de s'en rendre compte.
   */

  connectTimeoutMs?: number
}

/**
 * Traduit une erreur de connexion SSH brute en message clair, selon sa vraie cause (réseau, DNS, auth, mauvais port)
 * sans ça, toute panne de provisioning affichait le même message générique et opaque, quelle que soit la raison réelle de l'echec.
 */
function formatSshConnectError(err: NodeJS.ErrnoException): string {
  const raw = err.message || String(err)
  if (err.code === "ECONNREFUSED") {
    return "Connexion refusée, Vérifié que le service SSH tourne sur cet hôte et que le port est correct."
  }
  if (err.code === "ETIMEDOUT" || err.code === "EHOSTUNREACH") {
    return "Hôte injoignable, vérifie l'adresse IP et la connectivité réseau vers ce Serveur."
  }
  if (err.code === "ENOTFOUND") {
    return "Hôte introuvable, vérifie l'adresse (le nom ne se résout pas)."
  }
  if (/all configured authentication methods failed/i.test(raw)) {
    return "Authentification refusée, vérifie le mot de passe ou la clé privée fournie."
  }
  if (/connection lost before handshake/i.test(raw)) {
    return "Connexion perdue avant la négociation SSH, le port répond, mais pas avec un vrai serveur SSH (vérifie le port choisi)."
  }
  return `Echec de connexion SSH : ${raw}`
}

/** Classicise une erreur SSH en un message user lisible (plutôt qu'un raw ssh2). */
export function classifySshError(err: unknown, opts?: SshConnectOptions): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const host = opts?.host ?? "hôte"
  if (/authentication methods? failed|authentication failed/i.test(raw)) {
    return new Error(`Authentification SSH refusée sur ${host} : clé/password invalide`)
  }
  if (/ETIMEDOUT|timed? ?out/i.test(raw) && /connect/i.test(raw)) {
    return new Error(`Connexion SSH à ${host} : délai dépassé (hôte injoignable ?)`)
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return new Error(`Connexion SSH à ${host} refusée (port fermé / pare-feu ?)`)
  }
  if (/handshake|host[ _]?key|fingerprint|no matching|hostkey/i.test(raw)) {
    return new Error(`Empreinte SSH de ${host} rejetée (TOFU) : vérifie l'hôte`)
  }
  return new Error(`SSH: ${raw}`)
}

/** Délai d'établissement de la connexion ; un hôte muet ne doit pas pendre indéfiniment. */
const SSH_CONNECT_TIMEOUT_MS = Number(process.env.SSH_CONNECT_TIMEOUT_MS) || 15_000

export class SshSession {
  private client: Client;
  private disposed = false;
  private constructor(client: Client) {
    this.client = client;
  }

  static connect(opts: SshConnectOptions): Promise<SshSession> {
    const timeoutMs = opts.connectTimeoutMs ?? 15_000;

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      /**
       * On pose notre propres minuterie plutôt que de compter sur le timeout interne de ssh2, qui
       * ne couvre que certaines phases de la connexion et pas un hôte qui ne répond simplement jamais. Dés qu'elle se
       * déclencge, on détruit le client pour ne pas laisser une connexion fantôme ouverte en arrière-plan.
       */
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(
          new Error(
            `Delai de connexion dépassé après ${Math.round(timeoutMs / 1000)}s. L'hôte ne répond pas, vérifie l'adresse et que le port SSH est bien accessible.`,
          ),
        );
      }, timeoutMs);
      client
        .on("ready", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new SshSession(client));
        })
        .on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(formatSshConnectError(err)));
        })
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
            // On retire le padding final pour rester cohérent avec le
            // format que produit ssh-keyscan, qui n'en garde pas non plus.
            const fp =
              "sha256:" +
              createHash("sha256")
                .update(key)
                .digest("base64")
                .replace(/=+$/, "");
            opts.onHostKey?.(fp);
            // Comparaison insensible à la casse, car ssh-keyscan écrit
            // souvent "SHA256:" en majuscules alors que nous produisons
            // "sha256:" en minuscules.
            if (
              opts.knownHostKeyFp &&
              opts.knownHostKeyFp.toLowerCase() !== fp.toLowerCase()
            ) {
              return false;
            }
            return true;
          },
        });
    });
  }

  /** Exécute une commande, agrège stdout/stderr, renvoie le code de sortie. */
  exec(command: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream
          .on("close", (code: number) =>
            resolve({ stdout, stderr, code: code ?? 0 }),
          )
          .on("data", (d: Buffer) => (stdout += d.toString()))
          .stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      });
    });
  }

  /**
   * Ouvre un canal de type "direct-tcpip" vers dstHost:dstPort, depuis le
   * serveur distant lui-même. C'est ce qui permet à hullbay de parler à des
   * ports qui n'écoutent que sur localhost de la machine distante, sans
   * jamais les exposer sur le réseau public.
   */
  forwardOut(dstHost: string, dstPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut(
        "127.0.0.1",
        0,
        dstHost,
        dstPort,
        (err, stream) => {
          if (err) return reject(new Error(`SSH forwardOut: ${err.message}`));
          resolve(stream);
        },
      );
    });
  }
  /**
   * Ajoute une clé publique aux authorized_keys du serveur distant, sans la
   * dupliquer si elle y est déjà. La clé publique n'a rien de secret, donc
   * rien de sensible ne transite ici.
   */
  async appendAuthorizedKey(publicKey: string): Promise<void> {
    const cmd =
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `chmod 600 ~/.ssh/authorized_keys && ` +
      `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || ` +
      `echo ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`;
    const res = await this.exec(cmd);
    if (res.code !== 0) throw new Error(`authorized_keys: ${res.stderr}`);
  }

  /** Déclenché quand la connexion SSH se ferme, que ce soit une coupure réseau, un arrêt du serveur distant, ou une fin de session normale. */
  onClose(cb: () => void): void {
    this.client.on("close", cb);
  }

  /**
   * Déclenché sur une erreur de connexion en cours de session. Une erreur
   * est souvent suivie d'un événement de fermeture juste après, mais ce
   * callback permet de réagir dès le premier signal, sans attendre.
   */
  onError(cb: (err: Error) => void): void {
    this.client.on("error", (e) => cb(new Error(`SSH: ${e.message}`)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.end();
  }
}

/** Échappe une valeur pour l'insérer sans risque comme argument shell, entouré de simples quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
