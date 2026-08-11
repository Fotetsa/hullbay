# Mises à jour de l'instance — Guide développeur

Architecture du module `updates`, conventions et points sensibles. Destiné aux
contributeurs qui touchent au backend (`packages/api/src/modules/updates`) ou à
l'interface (`packages/web`).

## 1. Vue d'ensemble

Le système permet de mettre à jour l'installation hullbay depuis l'interface,
sans SSH. Pipeline :

```
apply → backup pg_dump → pull images GHCR → rolling update web → rolling update
api (SELF-TERMINATING : le process meurt) → finalisation au boot suivant
```

Pourquoi une finalisation au boot ? L'API se remplace elle-même : son conteneur
est recréé pendant l'update, le process meurt avant de marquer la fin. Au
démarrage, la nouvelle API (`finalizeOrphanUpdates`) compare le tag de l'image
**réellement déployée** du service api (Docker, pas l'env) aux updates
orphelines `running` :

- tag atteint → `success`, et le step `api` est basculé en `success` (le process
  étant mort avant, c'est la finalisation qui débloque la barre de progression
  front à 100 %) ;
- tag non atteint → `failed` + rollback automatique (restauration du dump puis
  ancien tag).

Le dump est indispensable : les migrations Prisma tournent **au boot** de la
nouvelle API (Dockerfile CMD `prisma migrate deploy`) — un rollback d'image seul
ne déferait pas un schéma déjà migré.

## 2. Fichiers

### Backend (`packages/api/src/modules/updates/`)

| Fichier | Rôle |
|---|---|
| `github.ts` | `GitHubReleasesService` : lecture releases GitHub, parseur **semver maison** (`compareVersions`), cache TTL 5 min par (canal, limit), ne cache pas les erreurs. Singleton `githubReleasesService` (fetch injectable en test). |
| `updater.ts` | `UpdaterService` : `check`, `current`, `setChannel` (audit), `history` (paginé), `apply`, `rollback`, `finalizeOrphanUpdates`, `pgEnv()`. |
| `routes.ts` | Routes Fastify `/api/updates/*`, toutes `owner` (RBAC `requireRole("owner")`). |

### Schéma (`prisma/schema.prisma`)

- `SystemInfo` : singleton, `currentVersion` (seedé au boot depuis `IMAGE_TAG`),
  `updateChannel`, `lastCheckAt`, `lastCheckResult` (JSON), `channelHistory`
  (JSON : audit des bascules de canal, max 10).
- `SystemUpdate` : une entrée par apply/rollback, `steps`/`logs` en JSON
  (persistés pour traçabilité post-mortem). Champs rollback : `rolledBack`
  (marqué sur l'update d'origine quand son rollback aboutit) et `rollbackOfId`
  (un enregistrement rollback pointe vers l'update qu'il annule).

### Web (`packages/web/src`)

| Fichier | Rôle |
|---|---|
| `lib/api.ts` | Types + méthodes `updatesCheck/updatesHistory/updatesStatus/setUpdateChannel/applyUpdate/rollbackUpdate`. |
| `lib/useUpdates.ts` | Hook `useUpdatesCheck` (poll 6 h, partagé badge + page). |
| `lib/useUpdateSocket.ts` | Abonnement aux events `update.*` (broadcast serveur). |
| `lib/useOpsSocket.ts` | Fabrique socket (`/ws`, Bearer). |
| `pages/UpdatesPage.tsx` | Page : toggle bêta, carte Instance, versions publiées, pipeline live dans la carte, historique, modal de confirmation, rollback. |
| `components/AppLayout.tsx` | Nav item `/updates` + badge « Nouveau ». |

## 3. API (résumé)

Routes (toutes owner-only, JWT Bearer) :

| Méthode | Route | Corps / Query |
|---|---|---|
| GET | `/api/updates/check?channel=stable\|beta` | — |
| GET | `/api/updates/current` | — |
| PUT | `/api/updates/channel` | `{ channel: "stable"\|"beta" }` |
| GET | `/api/updates/history?limit&offset&status` | limit ≤ 100, status enum |
| GET | `/api/updates/status/:id` | — |
| POST | `/api/updates/apply` | `{ channel?, version? }` → 202 `{ id }` |
| POST | `/api/updates/:id/rollback` | → 202 `{ id, status: "running" }` (id = nouvel enregistrement rollback) |

`history` renvoie `{ items, total, hasMore }`. `check` renvoie `degraded` (null
ou message) en cas de rate-limit/réseau : l'état est reserté depuis
`lastCheckResult`, `lastCheckResult` n'est **pas** réécrit, aucun throw.

## 4. Temps réel

Le serveur relaie les events via l'event bus (`update.step`, `update.progress`,
`update.done`, `update.error`) en **broadcast global** sur tous les sockets
connectés. Le client filtre par `updateId`.

> Note : `update.*` est broadcasté à tous les rôles connectés (viewer/operator
> inclus). Fuite mineure de métadonnées de versions — à durcir (filtre par rôle)
> si besoin.

Poll de sécurité : la page poll `/api/updates/status/:id` toutes les 2 s tant
que le statut n'est pas terminal (`success`/`failed`/`rolled_back`), filet de
sécurité pendant le redémarrage de l'API (le socket disparaît).

## 5. Variables d'environnement

| Variable | Rôle |
|---|---|
| `GITHUB_TOKEN` | Optionnel — augmente le quota GitHub (60 → 5000 req/h), sinon cache TTL. |
| `GITHUB_OWNER` / `GITHUB_REPO` | Défauts : `GHCR_OWNER` / `hullbay`. |
| `IMAGE_REGISTRY` | Override du registre d'images hullbay (défaut `ghcr.io`). Usage : test local/registre de confiance — voir §6. |
| `BACKUP_DIR` | Répertoire des dumps (défaut `/app/backups`, volume `ops_backups`). |
| `DATABASE_URL` | **Jamais** passée en argv du pg_dump (visible via `ps`) — uniquement via env `PG*` construits par `pgEnv()` (`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, `decodeURIComponent` requis). |

Sécurité images : seules
`{IMAGE_REGISTRY|ghcr.io}/{ghcr_owner|fotetsa}/hullbay/{api|web}:*` sont
acceptées pour l'update ; la version doit matcher
`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`. Le pattern de validation
(`docker-engine/service.ts`) lit `IMAGE_REGISTRY` : en override, **les services
déployés doivent déjà référencer ce registre** (image courante ET cible).

## 6. Pièges connus

1. **`logs` JSON : ne jamais utiliser `{ push: … }`** — Prisma 5.x stocke
   `{ push: value }` comme **objet littéral** (`{"push": …}`), pas un append. Un
   spread sur ce résultat lève `is not iterable` et casse le rollback/la
   finalisation. Toujours read-modify-write avec un garde `Array.isArray`
   (comme `log` / `logTo` dans `updater.ts`).
2. **Parsing du tag d'image** — `currentSystemTag` lit le tag après le dernier
   `/` puis le dernier `:` : robuste aux registres avec port
   (`host:port/owner/app:tag`). Ne jamais utiliser `/:(.+)$/` (le port du
   registre casse le match).
3. **Step `api` laissé `running`** — le process meurt pendant son propre update.
   C'est `finalizeOrphanUpdates` qui le bascule en `success` sur tag atteint.
   Sans ça, le front (progression = steps `success` / total) reste bloqué sous
   100 % alors que le statut est déjà `success`.

## 7. Points sensibles

1. **Ordre du rollback** : le restore DB (`pg_restore`) précède **tout**
   redeploy — le redeploy API tue le process. Le statut `rolled_back` est
   persisté avant le redeploy (délibéré).
2. **Modèle du rollback** : le rollback manuel crée un **nouvel enregistrement**
   (historique préservé) lié à l'update source par `rollbackOfId`. L'update
   source ne devient `rolledBack=true` qu'une fois le restore réussi — un
   rollback échoué (statut `failed` sur l'enregistrement rollback) laisse la
   source annulable (retry). Garde « latest-only » : seule l'update la plus
   récente appliquée est annulable (restaurer un vieux dump par-dessus des
   données plus récentes = perte de données).
3. **Placeholders** `latest`/`unknown` : `current()` les auto-répare (le défaut
   `latest` casse la comparaison semver) via le tag réellement déployé.
4. **Verrou anti-concurrence** : `apply` refuse si une entrée
   `pending|running` existe.
5. **Cache GitHub** : par processus, vidé au redémarrage — acceptable (le quota
   se refait en 60 s).
6. **Versions tronquées** : notes de la dernière release limitées à 500
   caractères dans `latest`, 1000 dans `releases` (JSON payload raisonnable).

## 8. Tests

```bash
cd packages/api
npx vitest run src/modules/updates     # github + routes + updater (service)
npm run test:coverage                  # couverture modules (updates > 80 %)
npm run typecheck
```

Web (E2E, API stubée — aucun service requis) :

```bash
cd packages/web
npm run e2e:install   # une fois : télécharge Chromium
npm run e2e
```

Les specs `packages/web/e2e/updates.spec.ts` interceptent `/api/**` via
`page.route` et couvrent : rendu de la carte Instance, navigation badge,
pagination de l'historique, lancement apply (suivi live), rollback avec
double confirmation, restriction non-owner.
