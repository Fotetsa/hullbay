/**
 * Politique de concurrence du Backup Engine (reviewer #16).
 *
 * Un backup peut être très coûteux (CPU/RAM/IO/DB). On borne donc le nombre
 * d'exécutions simultanées PAR PROCESSUS API via un sémaphore, réglable par
 * `BACKUP_MAX_CONCURRENCY` (défaut 2). En HA, le lease par policy empêche deux
 * instances de lancer le MÊME backup ; ce sémaphore borne la charge locale.
 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }
}

function parseMax(): number {
  const raw = Number.parseInt(process.env.BACKUP_MAX_CONCURRENCY ?? "", 10)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 16) return raw
  return 2
}

export const backupSemaphore = new Semaphore(parseMax())
