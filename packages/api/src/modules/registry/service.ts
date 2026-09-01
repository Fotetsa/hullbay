import { prisma } from "../../lib/prisma"
import { encryptSecret, decryptSecret } from "../auth/crypto"

/**
 * Credentials de registre Docker (GHCR par défaut). Token chiffré AES-256-GCM.
 * Sert à : (a) `docker login` sur chaque nœud au provisioning, (b) passer un
 * authconfig à pullImage/createService pour les images privées.
 */
export interface DockerAuthConfig {
  username: string
  password: string
  serveraddress: string
}

export class RegistryService {
  /** Définit/remplace les credentials d'un registre (upsert par registry). */
  async set(registry: string, username: string, token: string) {
    const existing = await prisma.registryCredential.findFirst({ where: { registry } })
    if (existing) {
      return prisma.registryCredential.update({
        where: { id: existing.id },
        data: { username, tokenEnc: encryptSecret(token) },
      })
    }
    return prisma.registryCredential.create({
      data: { registry, username, tokenEnc: encryptSecret(token) },
    })
  }

  /** Liste sans révéler les tokens. */
  async list() {
    const creds = await prisma.registryCredential.findMany()
    return creds.map((c: any) => ({ id: c.id, registry: c.registry, username: c.username }))
  }

  async remove(id: string) {
    await prisma.registryCredential.delete({ where: { id } })
  }

  /** authconfig dockerode pour un registre (déchiffre le token). null si absent. */
  async getAuthConfig(registry = "ghcr.io"): Promise<DockerAuthConfig | null> {
    const cred = await prisma.registryCredential.findFirst({ where: { registry } })
    if (!cred) return null
    return {
      username: cred.username,
      password: decryptSecret(cred.tokenEnc),
      // Docker Hub attend l'adresse canonique ; les autres registres = leur host.
      serveraddress:
        registry === "docker.io" ? "https://index.docker.io/v1/" : registry,
    }
  }

  /** Tous les registres configurés pour `docker login` au provisioning (tokens déchiffrés). */
  async listForLogin(): Promise<{ username: string; token: string; registry: string }[]> {
    const creds = await prisma.registryCredential.findMany()
    return creds.map((c: any) => ({
      username: c.username,
      token: decryptSecret(c.tokenEnc),
      registry: c.registry,
    }))
  }

  /** Credentials d'un registre donné pour le provisioning. */
  async getLoginCredentials(registry = "ghcr.io"): Promise<{ username: string; token: string; registry: string } | null> {
    const cred = await prisma.registryCredential.findFirst({ where: { registry } })
    if (!cred) return null
    return { username: cred.username, token: decryptSecret(cred.tokenEnc), registry }
  }
}

export const registryService = new RegistryService()
