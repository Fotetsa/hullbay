import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { prisma } from "../../lib/prisma"
import { eventBus } from "../../lib/event-bus"
import { githubReleasesService, type Channel } from "./github"
import { DockerEngineService } from "../docker-engine/service"

/**
 * UpdaterService — orchestration des mises à jour de l'instance self-hosted.
 *
 * Pipeline apply :
 *   1. verrou anti-concurrence (une seule update à la fois)
 *   2. backup PostgreSQL (pg_dump, client intégré à l'image API)
 *   3. détermination de la version cible (canal stable/beta ou tag explicite)
 *   4. pull des images GHCR (api + web)
 *   5. rolling update web (non mortel)
 *   6. rolling update API (SELF-TERMINATING : ce process meurt avec le conteneur)
 *   7. finalisation au boot suivant (reprise des updates `running` orphelines)
 *
 * Pourquoi la finalisation au boot ? L'API se remplace elle-même : le conteneur
 * est recréé pendant l'update → le process meurt avant de pouvoir marquer la fin.
 * Au redémarrage, la nouvelle API compare IMAGE_TAG (env) à l'update orpheline :
 *   - tag atteint            → success (+ audit)
 *   - tag non atteint        → failed + rollback automatique (restore dump + ancien tag)
 * Le dump DB est indispensable : les migrations Prisma tournent AU BOOT de la
 * nouvelle API (Dockerfile CMD) — un rollback simple d'image ne suffirait pas à
 * défaire un schéma déjà migré.
 */

const BACKUP_DIR_DEFAULT = "/app/backups"
const backupDir = () => process.env.BACKUP_DIR || BACKUP_DIR_DEFAULT

export type UpdateStep = {
  name: string
  status: "pending" | "running" | "success" | "failed"
  error?: string
}

export class UpdaterService {
  private docker = new DockerEngineService()
  private currentRun: Promise<void> | null = null

  /** Attente de la fin du pipeline en cours (utile aux tests / shutdown propre). */
  async waitForPending(): Promise<void> {
    await this.currentRun
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  /**
   * Infos de l'instance (singleton SystemInfo, seedé au boot depuis IMAGE_TAG).
   * Auto-répare les placeholders "latest"/"unknown" : ces valeurs cassent la
   * détection d'update (comparaison lexicographique en fallback : "latest" >
   * "1.2.3") → on les résout vers la version réellement déployée (tag du
   * service api dans Swarm, puis env IMAGE_TAG, sinon "unknown").
   */
  async current() {
    const placeholder = new Set(["latest", "unknown"])
    const existing = await prisma.systemInfo.findUnique({ where: { id: "singleton" } })
    if (existing && !placeholder.has(existing.currentVersion)) return existing
    const tag = await this.effectiveCurrentVersion()
    if (existing) {
      if (existing.currentVersion === tag) return existing
      return prisma.systemInfo.update({
        where: { id: "singleton" },
        data: { currentVersion: tag },
      })
    }
    return prisma.systemInfo.create({ data: { id: "singleton", currentVersion: tag } })
  }

  /**
   * Version courante effective : tag de l'image réellement déployée du service
   * api (source de vérité), sinon env IMAGE_TAG, sinon "unknown". Le tag
   * "latest" est rejeté partout (ambigu : peut pointer n'importe quelle
   * version, et casse la comparaison semver).
   */
  private async effectiveCurrentVersion(): Promise<string> {
    try {
      const deployed = await this.docker.currentSystemTag("api")
      if (deployed && deployed !== "latest") return deployed
    } catch {
      // docker indisponible → fallback sur l'env.
    }
    const tag = process.env.IMAGE_TAG
    return tag && tag !== "latest" ? tag : "unknown"
  }

  /** Vérification de mise à jour : dernière release du canal vs version courante. */
  async check(channel?: Channel) {
    const info = await this.current()
    const targetChannel = channel ?? (info.updateChannel as Channel) ?? "stable"
    const currentVersion = info.currentVersion

    let releases: Awaited<ReturnType<typeof githubReleasesService.listReleases>> = []
    let degraded: string | null = null
    try {
      releases = await githubReleasesService.listReleases(targetChannel, 20)
    } catch (err) {
      // Dégradé (rate-limit GitHub 403, réseau…) : on ne casse pas la page — on
      // resert la dernière vérification connue au lieu d'alerter en erreur.
      degraded = err instanceof Error ? err.message : String(err)
    }

    const latest = releases[0] ?? null
    // "unknown" (pas d'IMAGE_TAG en dev) : on considère qu'une release existe → dispo.
    const updateAvailable =
      latest !== null &&
      (currentVersion === "unknown" ||
        githubReleasesService.isUpdateAvailable(currentVersion, latest.version))

    // En mode dégradé on ne réécrit PAS lastCheckResult : on garde le dernier
    // état connu (la ligne "Dernière vérification" reste à la précédente).
    // Canal "all" (liste versions combinée) : on ne persiste rien non plus — le
    // cache héros ne doit pas être pollué par une vue agrégée.
    const isRealChannel = targetChannel === "stable" || targetChannel === "beta"
    if (!degraded && isRealChannel) {
      await prisma.systemInfo.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", lastCheckAt: new Date(), lastCheckResult: { channel: targetChannel, latestVersion: latest?.version ?? null, updateAvailable } },
        update: { lastCheckAt: new Date(), lastCheckResult: { channel: targetChannel, latestVersion: latest?.version ?? null, updateAvailable } },
      })
    }

    // Fallback : dernier résultat persisté (vérif antérieure OK).
    const cached = (info.lastCheckResult as { channel?: string; latestVersion?: string | null; updateAvailable?: boolean } | null) ?? {}
    return {
      currentVersion,
      updateChannel: targetChannel,
      updateAvailable: degraded ? (cached.updateAvailable ?? false) : updateAvailable,
      latestVersion: degraded ? (cached.latestVersion ?? null) : (latest?.version ?? null),
      latest: degraded || !latest
        ? null
        : { tag: latest.tag, version: latest.version, prerelease: latest.prerelease, publishedAt: latest.publishedAt, url: latest.url, notes: latest.notes.slice(0, 500) },
      // Liste des releases du canal (top 10) pour la page "Mises à jour".
      releases: releases.map((r) => ({
        version: r.version,
        tag: r.tag,
        prerelease: r.prerelease,
        publishedAt: r.publishedAt,
        url: r.url,
        notes: r.notes.slice(0, 1000),
      })),
      lastCheckAt: degraded ? (info.lastCheckAt ?? new Date()) : new Date(),
      degraded,
      // Audit des changements de canal (dernier au début).
      channelHistory: Array.isArray(info.channelHistory) ? info.channelHistory.slice(0, 10) : [],
    }
  }

  async history(opts: { limit?: number; offset?: number; status?: string } = {}) {
    const limit = opts.limit ?? 20
    const offset = opts.offset ?? 0
    const where = opts.status ? { status: opts.status } : undefined
    const [items, total] = await Promise.all([
      prisma.systemUpdate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemUpdate.count({ where }),
    ])
    return { items, total, hasMore: offset + items.length < total }
  }

  /** Appende un changement de canal à l'audit (max 10 entrées, dernière au début). */
  private appendChannelHistory(history: unknown, change: { at: Date; from: string; to: string }) {
    const parsed: unknown[] = Array.isArray(history) ? history : []
    return [change, ...parsed].slice(0, 10) as unknown as
      | {
          at: Date
          from: string
          to: string
        }[]
      | undefined
  }

  /** Change le canal de mise à jour de l'instance (persisté + audit). */
  async setChannel(channel: Channel): Promise<void> {
    const existing = await prisma.systemInfo.findUnique({ where: { id: "singleton" } })
    const from = (existing?.updateChannel as Channel | null) ?? "stable"
    if (from === channel) return
    const history = this.appendChannelHistory(existing?.channelHistory, {
      at: new Date(),
      from,
      to: channel,
    })
    await prisma.systemInfo.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", updateChannel: channel, channelHistory: history },
      update: { updateChannel: channel, channelHistory: history },
    })
  }

  async status(id: string) {
    return prisma.systemUpdate.findUnique({ where: { id } })
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Lance une mise à jour. Retourne l'id de l'update (202) — l'exécution continue
   * en arrière-plan, la progression est diffusée via eventBus (events update:*).
   * Lève si une update est déjà en cours.
   */
  async apply(opts: { channel?: Channel; version?: string }, userId: string | null): Promise<string> {
    const info = await this.current()
    const fromVersion = info.currentVersion
    const channel = opts.channel ?? (info.updateChannel as Channel) ?? "stable"

    // Verrou anti-concurrence : une seule update active à la fois.
    const active = await prisma.systemUpdate.findFirst({
      where: { status: { in: ["pending", "running"] } },
    })
    if (active) {
      throw new Error(`Une mise à jour est déjà en cours (${active.id})`)
    }

    const update = await prisma.systemUpdate.create({
      data: {
        status: "running",
        fromVersion,
        toVersion: opts.version ?? "?",
        channel,
        triggeredById: userId,
        startedAt: new Date(),
        steps: [],
        logs: [],
      },
    })

    this.currentRun = this.runPipeline(update.id, fromVersion, channel, opts.version).catch((err) => {
      // L'erreur est déjà gérée dans runPipeline (persistée + rollback). On ne
      // loggue ici que les imprévus non rattrapés (crash process, etc.).
      console.error(`[updates] pipeline ${update.id} crashed:`, err)
    })

    return update.id
  }

  /**
   * Rollback explicite d'une update réussie.
   *
   * Semantique historique : le rollback crée un NOUVEL enregistrement R lié à
   * l'update source (rollbackOfId). L'update d'origine (success) reste INTACTE
   * — seule sa balise rolledBack passe à true quand le rollback aboutit. Ainsi :
   *   - R réussi  → status rolled_back, X.rolledBack=true  → bouton de X disparaît,
   *                 R n'a jamais de bouton (statut rolled_back/failed).
   *   - R échoue  → status failed, X reste rolledBack=false → bouton de X persiste
   *                 (retry possible), R (failed) n'a pas de bouton.
   *
   * Garde de sécurité : seul un rollback de l'update la PLUS RÉCENTE appliquée est
   * accepté (la version déployée doit correspondre à toVersion). Restaurer un
   * vieux dump par-dessus des données plus récentes = perte de données.
   */
  async rollback(updateId: string, userId: string | null): Promise<string> {
    const update = await prisma.systemUpdate.findUnique({ where: { id: updateId } })
    if (!update) throw new Error("update introuvable")
    if (update.status !== "success") {
      throw new Error("seule une mise à jour réussie est annulable")
    }
    if (update.rolledBack) throw new Error("déjà rollbacké")
    if (!(await this.isLatestApplied(update.toVersion))) {
      throw new Error("update dépassée — rollback impossible")
    }
    const fromVersion = update.fromVersion
    if (!fromVersion || fromVersion === "unknown") {
      throw new Error("version source inconnue — rollback impossible")
    }

    const baseLogs = (l: unknown): string[] => (Array.isArray(l) ? (l as string[]) : [])
    // Nouvel enregistrement : le rollback EST un événement d'historique à part
    // entière (du point de vue de l'historique : fromVersion → toVersion inversés).
    const rb = await prisma.systemUpdate.create({
      data: {
        status: "running",
        fromVersion: update.toVersion,
        toVersion: fromVersion,
        channel: update.channel,
        rollbackOfId: update.id,
        triggeredById: userId,
        startedAt: new Date(),
        steps: [],
        logs: [`[rollback] restore du dump ${update.toVersion} → ${fromVersion}`],
      },
    })
    const rbId = rb.id

    try {
      // ORDRE CRITIQUE : la restauration de la DB se fait AVANT tout redeploy.
      // Le redeploy de l'API est self-terminating (le process meurt avec le
      // conteneur) — si on redéployait avant le restore, la base resterait au
      // nouveau schéma avec l'ancien code.
      await this.executeRollback({
        source: update,
        targetId: rbId,
        fromVersion,
        logs: baseLogs(rb.logs),
        trackSteps: true,
      })
      // L'update d'origine est marquée annulée UNIQUEMENT si le restore a réussi.
      await prisma.systemUpdate.update({
        where: { id: updateId },
        data: { rolledBack: true },
      })
      await eventBus.emit("update.done", {
        updateId: rbId,
        status: "rolled_back",
        fromVersion: update.toVersion,
        toVersion: fromVersion,
        userId,
      })
      return rbId
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.systemUpdate.update({
        where: { id: rbId },
        data: { status: "failed", error: `rollback: ${message}`, finishedAt: new Date() },
      })
      await eventBus.emit("update.error", { updateId: rbId, error: message, userId })
      throw err
    }
  }

  /**
   * Core d'un rollback : restore du dump de `source` puis statut rolled_back,
   * SystemInfo.currentVersion ← fromVersion et redeploy web puis api. Le record
   * `targetId` est passé à rolled_back AVANT le redeploy api (self-terminating).
   * `source` est l'update dont on restaure le dump (l'update qui l'a créé).
   */
  private async executeRollback(opts: {
    source: { id: string }
    targetId: string
    fromVersion: string
    logs: string[]
    /** true = enregistrement de rollback dédié (tracking d'étapes), false = mute d'une apply (étapes déjà présentes). */
    trackSteps?: boolean
  }): Promise<void> {
    const { source, targetId, fromVersion, logs, trackSteps = false } = opts
    const step = trackSteps
      ? (name: string, status: "running" | "success" | "failed") => this.setStep(targetId, name, status)
      : () => Promise.resolve()
    await step("restore", "running")
    await this.restoreBackup(this.backupFileName(source.id))
    await step("restore", "success")
    await prisma.systemUpdate.update({
      where: { id: targetId },
      data: {
        status: "rolled_back",
        finishedAt: new Date(),
        error: null,
        logs: [...logs, "[rollback] dump restauré"],
      },
    })
    await prisma.systemInfo.update({
      where: { id: "singleton" },
      data: { currentVersion: fromVersion },
    })
    if (fromVersion && fromVersion !== "unknown") {
      await step("web", "running")
      await this.updateServiceImage("web", fromVersion, targetId)
      await step("web", "success")
      // Dernier : l'API (le process meurt ici, le statut est déjà persisté).
      await step("api", "running")
      await this.updateServiceImage("api", fromVersion, targetId)
      await step("api", "success")
    } else {
      await logTo(targetId, "[rollback] fromVersion inconnue — aucun redeploy d'image")
    }
    await logTo(targetId, "[rollback] terminé")
  }

  /**
   * Garde latest-only : le rollback d'une update n'a de sens que si elle a amené
   * le système à sa version actuelle (sinon on restaurerait un dump obsolète sur
   * des données plus récentes → perte de données). Source de vérité : le tag
   * réellement déployé du service api, sinon SystemInfo (dev hors Swarm).
   */
  private async isLatestApplied(toVersion: string): Promise<boolean> {
    const deployed = await this.deployedApiTag()
    if (deployed !== null) return this.tagMatches(deployed, toVersion)
    const info = await prisma.systemInfo.findUnique({ where: { id: "singleton" } })
    if (!info) return true
    return info.currentVersion === "unknown" || this.tagMatches(info.currentVersion, toVersion)
  }

  // ── Pipeline interne ───────────────────────────────────────────────────────

  private async runPipeline(
    updateId: string,
    fromVersion: string,
    channel: Channel,
    explicitVersion?: string,
  ): Promise<void> {
    const log = async (message: string) => {
      try {
        const cur = await prisma.systemUpdate.findUnique({
          where: { id: updateId },
          select: { logs: true },
        })
        const base = Array.isArray(cur?.logs) ? cur.logs : []
        await prisma.systemUpdate.update({
          where: { id: updateId },
          data: { logs: [...base, `[${new Date().toISOString()}] ${message}`] },
        })
      } catch {
        // log non critique — ne casse jamais le pipeline
      }
    }
    const step = (name: string) => this.setStep(updateId, name, "running")
    const stepOk = (name: string) => this.setStep(updateId, name, "success")
    const stepFail = (name: string, error: string) => this.setStep(updateId, name, "failed", error)

    try {
      // Étape 1 — backup PostgreSQL.
      await step("backup")
      const backupFile = this.backupFileName(updateId)
      await this.dumpDatabase(backupFile)
      await log(`backup: ${backupFile}`)
      await stepOk("backup")

      // Étape 2 — version cible.
      await step("version")
      const latest = explicitVersion
        ? { version: explicitVersion }
        : await githubReleasesService.latest(channel)
      if (!latest) throw new Error("aucune release trouvée sur le canal demandé")
      const toVersion = latest.version
      // Garde anti-downgrade : on n'installe jamais une version <= à celle
      // déployée (le canal beta peut contenir des pre-release "anciennes").
      if (
        fromVersion !== "unknown" &&
        !githubReleasesService.isUpdateAvailable(fromVersion, toVersion)
      ) {
        throw new Error(
          `refusé : ${toVersion} n'est pas plus récent que ${fromVersion} (anti-downgrade)`,
        )
      }
      await prisma.systemUpdate.update({
        where: { id: updateId },
        data: { toVersion },
      })
      await log(`version cible: ${toVersion}`)
      await stepOk("version")

      // Étape 3 — pull des images.
      await step("pull")
      const image = (component: "api" | "web") => this.imageRef(component, toVersion)
      await this.docker.ensureImage(image("api"), "Always")
      await this.docker.ensureImage(image("web"), "Always")
      await log("images tirées (api + web)")
      await stepOk("pull")

      // Étape 4 — rolling update web (non mortel : l'API reste vivante).
      await step("web")
      await this.updateServiceImage("web", toVersion, updateId)
      // Santé du web APRÈS son update : on ne se suicide pas si le front est cassé.
      await this.waitForWebHealthy()
      await log("web mis à jour et sain")
      await stepOk("web")

      // Étape 5 — rolling update API (self-terminating : ce process meurt ici).
      await step("api")
      await log("update de l'API — le process va être remplacé, finalisation au boot")
      await this.updateServiceImage("api", toVersion, updateId)
      // On ne marque PAS success : la finalisation se fait au boot suivant
      // (voir finalizeOrphanUpdates). Si on arrive ici, l'update a été envoyée.
      await log("update API envoyée")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await stepFail("pipeline", message)
      await log(`ÉCHEC : ${message}`)
      await prisma.systemUpdate.update({
        where: { id: updateId },
        data: { status: "failed", error: message, finishedAt: new Date() },
      })
      await eventBus.emit("update.error", { updateId, error: message })
    }
  }

  private async updateServiceImage(component: "api" | "web", version: string, updateId: string) {
    const image = this.imageRef(component, version)
    await this.docker.updateSystemServiceImage(component, image)
    await eventBus.emit("update.progress", { updateId, component, version })
  }

  /**
   * Référence d'image d'un composant : registre IMAGE_REGISTRY (défaut ghcr.io)
   * + owner GHCR_OWNER + tag version. IMAGE_REGISTRY permet de pointer vers un
   * miroir/registre local (tests hors-ligne) sans changer de code.
   */
  private imageRef(component: "api" | "web", version: string): string {
    const registry = process.env.IMAGE_REGISTRY || "ghcr.io"
    const owner = process.env.GHCR_OWNER || "fotetsa"
    return `${registry}/${owner}/hullbay/${component}:${version}`
  }

  /**
   * Attend que le service web réponde après un rolling update (poll HTTP sur le
   * nom du service Swarm, résolu par le DNS overlay). Best-effort : si le DNS
   * ne résout pas (hors Swarm), on tolère et on continue — l'échec dur est déjà
   * couvert par le FailureAction=rollback de Swarm.
   */
  private async waitForWebHealthy(): Promise<void> {
    const found = await this.docker.findHullbayServices()
    const webName = found["web:name"]
    if (!webName) return // pas de service web Swarm (dev ?) → rien à sonder
    const probe = `http://${webName}/`
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const res = await fetch(probe, { signal: AbortSignal.timeout(3000) })
        if (res.ok) return
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(`web non sain après l'update (${probe}) — Swarm va rollbacker`)
  }

  /** Marque le statut d'une étape (pour la trace `steps` de l'update). */
  private async setStep(updateId: string, name: string, status: UpdateStep["status"], error?: string) {
    const update = await prisma.systemUpdate.findUnique({ where: { id: updateId } })
    if (!update) return
    const steps = ((update.steps as UpdateStep[]) ?? []).filter((s) => s.name !== name)
    steps.push({ name, status, error })
    await prisma.systemUpdate.update({ where: { id: updateId }, data: { steps } })
    await eventBus.emit("update.step", { updateId, name, status, error })
  }

  // ── Backup / restore PostgreSQL (pg_dump client embarqué dans l'image API) ──

  private backupFileName(updateId: string): string {
    return join(backupDir(), `hullbay-${updateId}.sql`)
  }

  private runPg(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // DATABASE_URL n'apparaît JAMAIS dans argv (visible via `ps` sur le
        // nœud Swarm) — les credentials passent par les variables PG* du child.
        env: { ...process.env, ...env },
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`)),
      )
    })
  }

  /** Parse DATABASE_URL en variables d'env PG* (jamais l'URL elle-même en argv). */
  private pgEnv(url: string): NodeJS.ProcessEnv {
    const u = new URL(url)
    return {
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    }
  }

  /**
   * pg_dump de DATABASE_URL vers un fichier (format custom, restaurable via
   * pg_restore). Exclut les tables de MÉTADONNÉE opérationnelles :
   *   - SystemUpdate (historique des updates + colonnes rollback) ;
   *   - SystemInfo (singleton version/canal, audit canal) ;
   *   - _prisma_migrations (état des migrations).
   * Elles ne contiennent AUCUNE donnée utilisateur et doivent SURVIVRE au
   * rollback : le restore revient à un dump dont le schéma est plus ancien que
   * le client Prisma courant — si ces tables étaient restaurées, toute requête
   * du client échouerait (colonnes ajoutées après le dump absentes) et
   * l'historique de l'update rollbackée serait perdu. L'état de schéma
   * (_prisma_migrations) doit rester cohérent avec les colonnes réellement
   * présentes, sinon le prochain `migrate deploy` tenterait de re-créer une
   * colonne déjà là.
   */
  async dumpDatabase(file: string): Promise<void> {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL non définie — backup impossible")
    mkdirSync(backupDir(), { recursive: true })
    await this.runPg(
      "pg_dump",
      [
        "-Fc",
        "-f",
        file,
        // Métadonnée exclue du backup (voir doc ci-dessus).
        "-T",
        'public."SystemUpdate"',
        "-T",
        'public."SystemInfo"',
        "-T",
        'public."_prisma_migrations"',
      ],
      this.pgEnv(url),
    )
  }

  /**
   * true si l'archive (-Fc) contient la table SystemUpdate. C'est le cas des
   * dumps produits par un code PRÉ-fix (avant les exclusions -T de
   * dumpDatabase). Les restaurer ramènerait les métadonnées opérationnelles à
   * leur schéma ancien → tout client Prisma courant casserait (colonnes
   * absentes) et l'historique serait perdu. On détecte via `pg_restore --list`
   * (lecture seule de l'archive, pas de connexion DB).
   */
  private async dumpContainsSystemUpdate(file: string): Promise<boolean> {
    const out = await this.runPg("pg_restore", ["--list", file], process.env)
    return /"SystemUpdate"/.test(out)
  }

  /**
   * Restaure un dump (-Fc) dans la base courante (destructive, à n'utiliser qu'en rollback).
   * NB : contrairement à psql/pg_dump, pg_restore IGNORE PGDATABASE — il exige un
   * `-d <dbname>` explicite. Le nom de base n'est pas un secret → ok en argv.
   *
   * SystemUpdate est EXCLU du dump (métadonnée préservée, voir dumpDatabase).
   * Sa FK vers User bloquerait le DROP --clean de la table User (dépendance) :
   * on retire la contrainte AVANT le restore et on la recrée APRÈS (les lignes
   * de SystemUpdate survivent au restore, les users référencés sont restaurés).
   */
  async restoreBackup(file: string): Promise<void> {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL non définie — restore impossible")
    const env = this.pgEnv(url)
    const dbName = env.PGDATABASE ?? "postgres"
    const dropFk = 'ALTER TABLE "SystemUpdate" DROP CONSTRAINT IF EXISTS "SystemUpdate_triggeredById_fkey"'
    const addFk =
      'ALTER TABLE "SystemUpdate" ADD CONSTRAINT "SystemUpdate_triggeredById_fkey" ' +
      'FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE'
    await this.runPg("psql", ["-d", dbName, "-v", "ON_ERROR_STOP=1", "-c", dropFk], env)
    const target = await this.prepareRestoreFile(file)
    try {
      await this.runPg(
        "pg_restore",
        ["--clean", "--if-exists", "--no-owner", "-d", dbName, target],
        env,
      )
    } finally {
      await this.runPg("psql", ["-d", dbName, "-v", "ON_ERROR_STOP=1", "-c", addFk], env)
    }
  }

  /**
   * Si l'archive de backup est un dump pré-fix (contient SystemUpdate), régénère
   * un dump propre depuis la base courante. Appelé AVANT le drop FK : toute
   * erreur ici ne laisse pas la contrainte en suspens.
   */
  private async prepareRestoreFile(file: string): Promise<string> {
    let isLegacy = false
    try {
      isLegacy = await this.dumpContainsSystemUpdate(file)
    } catch {
      // Archive ILLISIBLE : produite par un pg_dump plus récent que le client
      // courant (ex. ancienne image api avec pg_dump 18 → archive v1.16 que
      // pg_restore 16 ne sait ni lister ni restaurer). On ne peut pas
      // l'inspecter → on régénère un dump propre, sinon le rollback échoue.
      isLegacy = true
    }
    if (!isLegacy) return file
    // Backup pré-fix (sans exclusions) : un restore direct ramènerait les
    // métadonnées opérationnelles à leur schéma ancien → tout client Prisma
    // courant casserait (colonnes absentes) et l'historique serait perdu. NB :
    // les données utilisateur restaurées sont alors celles DU MOMENT du
    // rollback (pas l'état pré-update) — compromis pour rester fonctionnel.
    const target = `${file}.regen`
    await this.dumpDatabase(target)
    return target
  }

  // ── Finalisation au boot (reprise des updates orphelines) ──────────────────

  /**
   * À appeler une fois au démarrage de l'API. Reprend les updates `running`
   * laissées orphelines par la mort du process (self-terminating) :
   *   - tag réellement déployé (service api dans Swarm) atteint → success
   *   - sinon → failed (+ rollback automatique : restore dump + ancien tag)
   *
   * Source de vérité : le TAG DE L'IMAGE réellement déployée du service api,
   * pas l'env IMAGE_TAG (défaut `latest` dans install.sh → fausserait le
   * verdict : toute update vers une version semver serait vue "non atteinte").
   * Si Swarm a déjà rollbacké l'image (FailureAction), le tag redeviendra
   * l'ancien → on retombe ici dans la branche rollback DB.
   */
  async finalizeOrphanUpdates(): Promise<void> {
    const orphans = await prisma.systemUpdate.findMany({
      where: { status: "running" },
      orderBy: { createdAt: "desc" },
    })
    for (const update of orphans) {
      const deployedTag = await this.deployedApiTag()
      if (deployedTag === null) {
        // Docker injoignable au boot (ou stack non déployée) : impossible de
        // trancher. On NE ROLLBACKE PAS (pg_restore est destructif) — on laisse
        // l'update en "running", la décision sera retentée au prochain boot.
        await logTo(update.id, "[finalize] tag déployé illisible (docker indisponible ?) — retenté au prochain boot")
        continue
      }
      if (this.tagMatches(deployedTag, update.toVersion)) {
        // Le step "api" était resté "running" : le process meurt pendant son propre
        // update. La finalisation au boot (ici) est le seul endroit où l'on peut
        // le basculer en success — sinon la barre de progression reste bloquée.
        await this.setStep(update.id, "api", "success")
        await prisma.systemUpdate.update({
          where: { id: update.id },
          data: { status: "success", finishedAt: new Date(), error: null },
        })
        await prisma.systemInfo.update({
          where: { id: "singleton" },
          data: { currentVersion: update.toVersion },
        })
        await eventBus.emit("update.done", { updateId: update.id, status: "success", fromVersion: update.fromVersion, toVersion: update.toVersion })
      } else {
        // Échec : l'image n'a pas atteint la version cible → rollback automatique.
        // On mute l'orpheline EN PLACE (pas de nouvel enregistrement) : l'auto-
        // rollback est la conclusion du même événement, pas une opération distincte.
        const baseLogs = (l: unknown): string[] => (Array.isArray(l) ? (l as string[]) : [])
        try {
          await this.executeRollback({
            source: update,
            targetId: update.id,
            fromVersion: update.fromVersion,
            logs: baseLogs(update.logs),
          })
          await logTo(update.id, `[finalize] rollback automatique → ${update.fromVersion}`)
          await eventBus.emit("update.done", {
            updateId: update.id,
            status: "rolled_back",
            fromVersion: update.toVersion,
            toVersion: update.fromVersion,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await prisma.systemUpdate.update({
            where: { id: update.id },
            data: { status: "failed", error: `rollback auto: ${message}`, finishedAt: new Date() },
          })
        }
      }
    }
  }

  /** Tag actuellement déployé du service api (null hors Swarm / introuvable). */
  private async deployedApiTag(): Promise<string | null> {
    try {
      return await this.docker.currentSystemTag("api")
    } catch {
      return null
    }
  }

  /** Compare un tag déployé à la version cible (tolère le préfixe `v`). */
  private tagMatches(deployed: string, target: string): boolean {
    return deployed === target || deployed === `v${target}` || target === `v${deployed}`
  }
}

async function logTo(updateId: string, message: string) {
  try {
    const cur = await prisma.systemUpdate.findUnique({
      where: { id: updateId },
      select: { logs: true },
    })
    const base = Array.isArray(cur?.logs) ? cur.logs : []
    await prisma.systemUpdate.update({
      where: { id: updateId },
      data: { logs: [...base, message] },
    })
  } catch {}
}

/** Singleton partagé. */
export const updaterService = new UpdaterService()
