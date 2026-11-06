import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  decryptBackupSecret,
  decryptSecret,
  encryptBackupSecret,
  rotate,
} from "../secrets/secret-encryption-service"

const KEY = "11".repeat(32)
const KEY_NEW = "22".repeat(32)

describe("scope de chiffrement backup", () => {
  beforeAll(() => {
    process.env.BACKUP_ENCRYPTION_KEY = KEY
  })

  afterAll(() => {
    delete process.env.BACKUP_ENCRYPTION_KEY
    delete process.env.BACKUP_ENCRYPTION_KEY_NEW
  })

  it("fait un aller-retour sans altérer la valeur", () => {
    const secret = JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "s3cr3t" })
    const encrypted = encryptBackupSecret(secret)
    expect(encrypted).not.toContain("s3cr3t")
    expect(decryptBackupSecret(encrypted)).toBe(secret)
  })

  it("est isolé du scope mfa : un payload backup n'est pas lisible par la façade", () => {
    const encrypted = encryptBackupSecret("credential")
    expect(() => decryptSecret(encrypted)).toThrow()
  })

  it("ne déchiffre pas un payload mfa avec la clé backup", () => {
    // encryptSecret utilise la clé mfa (repli JWT_SECRET dans les tests).
    const mfaPayload = `${Buffer.alloc(12).toString("hex")}:${Buffer.alloc(16).toString("hex")}:00`
    expect(() => decryptBackupSecret(mfaPayload)).toThrow()
  })

  it("fait tourner la clé sans perdre la valeur", async () => {
    const encrypted = encryptBackupSecret("rotate-me")
    process.env.BACKUP_ENCRYPTION_KEY_NEW = KEY_NEW

    let stored = encrypted
    const result = await rotate("backup", [{ ref: "dest_1", encrypted }], (next) => {
      stored = next
      return next
    })
    expect(result).toEqual({ rotated: 1, skipped: 0, failed: 0 })
    expect(stored).not.toBe(encrypted)

    // Bascule : la nouvelle clé devient courante.
    process.env.BACKUP_ENCRYPTION_KEY = KEY_NEW
    expect(decryptBackupSecret(stored)).toBe("rotate-me")

    // Idempotence : un second passage saute l'enregistrement déjà tourné.
    const again = await rotate("backup", [{ ref: "dest_1", encrypted: stored }], () => {
      throw new Error("ne doit pas re-chiffrer")
    })
    expect(again).toEqual({ rotated: 0, skipped: 1, failed: 0 })

    process.env.BACKUP_ENCRYPTION_KEY = KEY
  })
})
