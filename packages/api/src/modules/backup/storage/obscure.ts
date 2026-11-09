import { createCipheriv, randomBytes } from "node:crypto"

/**
 * `rclone obscure` — les backends SFTP/WebDAV/SMB attendent un mot de passe
 * *obscurci* dans la connection-string (`pass=…`), jamais en clair.
 *
 * Algorithme public et stable de rclone : IV aléatoire de 16 octets préfixé au
 * chiffré, AES-256-CTR avec une clé statique, base64 URL sans padding.
 * La sortie est non déterministe (IV aléatoire) : le test live la fait relire
 * par le vrai binaire `rclone reveal`.
 */

// Clé statique de rclone (lib/obscure). Ce n'est PAS un secret : elle évite
// seulement les mots de passe en clair dans les fichiers de config.
const RCLONE_OBSCURE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8,
  0x86, 0xa9, 0x2b, 0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde,
  0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
])

export function obscureSecret(plain: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-ctr", RCLONE_OBSCURE_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return Buffer.concat([iv, ciphertext])
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
