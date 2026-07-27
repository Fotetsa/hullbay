import { generateKeyPairSync } from "node:crypto"
import { encryptSecret, decryptSecret } from "../modules/auth/crypto"

/**
 * Génération de la "clé-outil" SSH (ed25519) que l'ops-panel dépose sur les
 * serveurs (authorized_keys) pour la maintenance future. La privée est CHIFFRÉE
 * (AES-256-GCM, même mécanisme que les secrets MFA). La clé PERSO de l'utilisateur
 * n'est jamais concernée ici (elle reste en mémoire le temps du provisioning).
 */
export interface ToolKeyPair {
  publicKey: string // format OpenSSH (ssh-ed25519 AAAA...)
  privateKeyEnc: string // PEM privée chiffrée
}

export function generateToolKeyPair(): ToolKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  // ssh2 accepte la clé privée PEM (pkcs8) directement pour l'auth.
  return {
    publicKey: spkiToOpenSsh(publicKey),
    privateKeyEnc: encryptSecret(privateKey),
  }
}

/** Déchiffre la clé privée-outil pour s'en servir avec ssh2. */
export function decryptToolPrivateKey(privateKeyEnc: string): string {
  return decryptSecret(privateKeyEnc)
}

/**
 * Convertit une clé publique ed25519 SPKI/PEM en format OpenSSH authorized_keys.
 * (Node n'a pas d'export OpenSSH natif pour ed25519 ; on encode le wire format.)
 */
function spkiToOpenSsh(spkiPem: string): string {
  const der = Buffer.from(
    spkiPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64"
  )
  // Les 32 derniers octets du SPKI ed25519 = la clé publique brute.
  const raw = der.subarray(der.length - 32)
  const type = Buffer.from("ssh-ed25519")
  const blob = Buffer.concat([
    lenPrefixed(type),
    lenPrefixed(raw),
  ])
  return `ssh-ed25519 ${blob.toString("base64")} hullbay
}

function lenPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  return Buffer.concat([len, buf])
}
