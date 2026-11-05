# Plan d'Implémentation — Hullbay Backup Engine (v2)

**Statut :** Plan révisé après retour Direction — prêt pour implémentation.
**Base factuelle :** audit direct du dépôt (`master` @ `e084708`, Authorization Engine phase 2 incluse), vérifié fichier par fichier.
**Changement de cadre vs v1 :** le système n'est plus « un backup PostgreSQL via Rclone » mais un **Backup Engine générique** pour toute donnée persistante de Hullbay. Rclone devient un simple **adapter** derrière une interface `StorageProvider`.

---

## 1. Objectif

Construire le système de sauvegarde de Hullbay, provider-neutral et moteur-neutral :

```
PersistentDataTarget → BackupPolicy → BackupEngine → BackupStrategy
   → BackupArtifact → StorageProvider → RcloneAdapter → S3 / SFTP / SMB / WebDAV / GCS / Azure
```

Contraintes non négociables :
1. **Zéro disk-fill** : aucun octet d'archive sur le disque du nœud Swarm.
2. **Aucune réouverture de `EXEC` / `CONTAINERS`** sur le socket-proxy (`docker-compose.yml:63-64`).
3. **Ajouter une DB ou un backend sans toucher au cœur du moteur** (registries, pas de `if engine === ...` dans l'engine).
4. **Un backup = un artifact restaurable**, pas un fichier posé sur S3.
5. **Aucun secret en clair** : ni en `Spec.Env`, ni en `Spec.Args`, ni en log, ni en réponse HTTP.

---

## 2. État des lieux factuel (vérifié)

| Élément | Réalité du dépôt |
|---|---|
| Backup existant | **Aucun** — 0 modèle, 0 module, 0 job, 0 rclone, 0 S3. Greenfield. |
| Types de nœuds | `container \| network \| volume \| gateway \| database` — `packages/shared/src/node-config.ts:326` (la v1 disait 4 : inexact). |
| Moteurs DB | `postgres \| mysql \| mongodb \| redis` avec providers dédiés — `node-config.ts:238`, `modules/database/providers/`. Les 4 stratégies natives ont donc déjà leur point d'ancrage. |
| Connexion DB | `ConnectionEndpoint { host, port, database, username, passwordSecretRef }` — `modules/database/types.ts:89-100`. Le mot de passe n'existe **que** comme référence de secret. |
| Exécution Swarm | `createService(name, config, labels, networks, mounts)` + `resolveSecretRefs` — `modules/docker-engine/service.ts:730-746` ; placement `:660-667` ; `restartPolicy` `:655` ; `assertNotSystem` `:754`. |
| Chiffrement | AES-256-GCM par scope, union **fermée** `SecretKind = "mfa" \| "provider" \| "session"` — `modules/auth/secrets/secret-encryption-service.ts:21-26`. Ajouter `"backup"` = 1 entrée de config + 1 clé d'env. |
| Jobs | 3 jobs `setInterval` enregistrés dans `server.ts:229-231` (drift, autoscaler, cluster-health). Aucune lib cron. |
| Garde-fous suppression | `prune-orphans.ts` : dry-run par défaut, protection `bozando.system=true`, périmètre par label. |
| Volumes DB | Labellisés `bozando.database.data=true`, exclus des 3 chemins de suppression — `schema.prisma` / `DatabaseConfig.retainDataOnDelete`. |
| Autorisation | Moteur `can()`/`require()` mergé (phase 2, `modules/authorization/`), **appelé par aucune route** (`index.ts:23`, doc `authorization-engine.md`). Catalogue `catalog/resource-catalog.ts` : 40 permissions, aucune `backup.*`. Modèles `Role`/`Policy`/`Team` déjà en base (`schema.prisma:404-544`). |

Conséquence : le moteur s'appuie sur l'existant (providers DB, `createService`, secrets, jobs) et n'introduit **aucun** nouveau daemon, **aucun** nouveau type de nœud canvas, **aucun** accès Docker supplémentaire.

---

## 3. Architecture — responsabilités par couche

### 3.1 `PersistentDataTarget` (couche cible)

Représente **ce qui est sauvegardé**, pas comment. Un target est une projection d'un `Node` existant :

| Kind | Source | Résolution |
|---|---|---|
| `postgres` / `mysql` / `mongodb` / `redis` | nœud `database` | `provider.connection(config, ctx)` → host/port/db/user/`passwordSecretRef` |
| `volume` | nœud `volume`, ou volumes montés d'un `container` | nom de volume Docker + chemin de montage |

Règles :
- **Pas de 6ᵉ type de nœud.** Un target référence `Node.id` (FK) et un `kind` ; la vérité de connexion reste la config du nœud.
- Un target `database` **ne peut pas** utiliser la stratégie `volume` par défaut (tar d'un datadir vivant = état incohérent). Le natif est imposé, le volume n'est proposé qu'en fallback explicite avec avertissement.
- Les identifiants ne sont **jamais** copiés dans le target : seule la référence de secret est conservée.

### 3.2 `BackupPolicy` (couche intention)

Une ressource peut avoir **plusieurs** policies (quotidien S3 30j + hebdo SFTP 12 semaines). Aucune dispersion de `schedule`/`retention`/`strategy` dans les modèles de nœuds.

```
BackupPolicy
  ├── targetId
  ├── destinationId
  ├── strategyId        (dérivé du kind, explicite pour l'extension future)
  ├── schedule          (preset daily|weekly|manual + heure ; V1 sans cron)
  ├── retentionDays
  ├── encryptionMode    (none en V1 — champ réservé)
  ├── verification      (size | checksum)
  ├── placement         (constraints Swarm — NAS local)
  ├── timeoutSec
  ├── maxConcurrency
  └── enabled
```

`backupDestinationId` posé directement dans la config du nœud (proposition v1) est **abandonné** : il devient un champ de `BackupPolicy`.

### 3.3 `BackupEngine` (cœur — ne connaît ni DB ni Rclone)

Responsabilités uniques :
- résolution target → strategy via **registry** ;
- cycle de vie d'un run (`RUNNING → COMPLETED | FAILED`, avec phase) ;
- orchestration du runner Swarm one-shot ;
- staging → vérification → commit ;
- rétention (après commit uniquement) ;
- chiffrement des credentials (délégué à la façade existante) ;
- historique, erreurs normalisées, lease anti-double-exécution.

Interdits structurels : aucun `switch (engine)`, aucun import de `rclone`, aucune commande shell propre au moteur.

### 3.4 `BackupStrategy` (sait extraire et restaurer)

Contrat pensé **dès maintenant** avec `restore()`, même si V1 ne l'implémente pas :

```ts
interface BackupStrategy {
  readonly id: string                     // "postgres.pg_dump"
  readonly targetKind: TargetKind
  readonly version: number                // version du format produit
  plan(target: ResolvedTarget): StrategyPlan        // commandes, format, prérequis
  backup(ctx: StrategyContext): ReadableStream     // stdout du dump, streaming
  restore(artifact: BackupArtifactRef, ctx: RestoreContext): Promise<void> // V1: NotImplemented
  verifyPrereqs(target: ResolvedTarget): PrereqResult  // ex. client pg_dump >= version serveur
}
```

Stratégies V1 :

| Strategy id | Outil | Format payload | Restauration standard |
|---|---|---|---|
| `postgres.pg_dump` | `pg_dump --format=plain` | `.sql.gz` | `gunzip -c \| psql` |
| `mysql.mysqldump` | `mysqldump --single-transaction` | `.sql.gz` | `gunzip -c \| mysql` |
| `mongodb.mongodump` | `mongodump --archive` | `.archive.gz` | `mongorestore --archive --gzip` |
| `redis.rdb` | `redis-cli --rdb -` | `.rdb.gz` | `redis-server --dbfilename` / `redis-cli --pipe` |
| `volume.tar` | `tar -C <mount> .` | `.tar.gz` | `tar -xzf` |

Registry : `Map<TargetKind, BackupStrategy>` enregistré au boot. Ajouter MySQL/MongoDB/Redis = **un fichier**, zéro modification du moteur. Chaque stratégie déclare son `restoreCommand` lisible dans le manifest.

### 3.5 `StorageProvider` (contrat) et `RcloneAdapter` (implémentation)

```ts
interface StorageProvider {
  readonly id: string
  capabilities(): Promise<StorageCapabilities>
  put(key: string, stream: ReadableStream, opts: PutOptions): Promise<PutResult>
  get(key: string): Promise<ReadableStream>
  stat(key: string): Promise<ObjectStat | null>
  list(prefix: string): Promise<ObjectStat[]>
  delete(key: string): Promise<void>
  move(from: string, to: string): Promise<boolean>   // false si non supporté
  hash(key: string): Promise<{ algorithm: string; value: string } | null>
}
```

`StorageCapabilities = { read, write, delete, move, checksum, atomicCommit, serverSideEncryption }`.

- Le cœur ne parle qu'à `StorageProvider`. **Aucun `rclone` hors de `storage/rclone-adapter.ts`.**
- L'adapter construit la remote-string **en mémoire** depuis les secrets montés (`:protocol,param=...:basePath`), applique un échappement strict, et **ne logge jamais** la chaîne.
- Un second adapter (S3 natif, ou `local` pour les tests) doit être possible sans toucher au moteur : c'est le test de validité du contrat.
- Les divergences de capacités (rename atomique absent sur SFTP/WebDAV) sont absorbées par l'adapter qui expose un `move()` dégradé (copy → verify → delete) et le signale via `capabilities()`.

### 3.6 `BackupArtifact` (résultat durable)

Layout sur le stockage distant, **auto-descriptif et récupérable sans Hullbay** :

```
<basePath>/<projectSlug>/<targetName>/<artifactId>/
  manifest.json
  payload.sql.gz
  payload.sha256
```

`manifest.json` minimal :

```json
{
  "formatVersion": 1,
  "artifactId": "bak_...",
  "createdAt": "2026-10-25T10:00:00Z",
  "target": { "nodeId": "...", "name": "orders-db", "kind": "postgres" },
  "source": { "engine": "postgres", "engineVersion": "16", "host": "boz_shop_db", "port": 5432, "database": "orders", "username": "app" },
  "strategy": { "id": "postgres.pg_dump", "version": 1, "tool": "pg_dump", "toolVersion": "16.4" },
  "payload": { "path": "payload.sql.gz", "format": "sql.gz", "sizeBytes": 12345678 },
  "checksum": { "algorithm": "sha256", "value": "..." },
  "encryption": { "mode": "none" },
  "commit": { "mode": "atomic-rename" },
  "restore": {
    "strategyId": "postgres.pg_dump",
    "command": "gunzip -c payload.sql.gz | psql -h <host> -U <user> -d <db>",
    "requires": { "engineMajor": ">=16" }
  }
}
```

Règle de commit : **un artifact n'existe que si `manifest.json` est présent à la clé finale.** Le manifest est uploadé en dernier. Un payload sans manifest = staging orphelin, jamais listé comme restaurable.

### 3.7 `BackupRun` vs `BackupArtifact`

| | `BackupRun` | `BackupArtifact` |
|---|---|---|
| Nature | tentative d'exécution | résultat durable restaurable |
| Cycle | `RUNNING → COMPLETED \| FAILED` (+ `phase`) | créé **une seule fois**, au commit |
| Contenu | timings, erreur, logs task, trigger | manifest, checksum, taille, clé de stockage |
| Cardinalité | N par policy | 0 ou 1 par run réussi |

Un run `FAILED` ne produit **jamais** d'artifact. Un artifact ne référence que des runs `COMPLETED`.

---

## 4. Lifecycle d'un backup

```
1. lease policy          (empêche 2 instances Hullbay de lancer le même backup)
2. BackupRun RUNNING     (phase = resolving)
3. resolve target        → ConnectionEndpoint / volume
4. prereqs               → client >= version serveur, destination joignable
5. runner Swarm one-shot (phase = extracting → transferring)
      strategy.backup() ──stream──▶ StorageProvider.put(".staging/<runId>/payload")
      checksum calculé PENDANT le stream (tee vers tmpfs, jamais sur disque)
6. verify                (phase = verifying)
      taille distante == taille streamée
      hash distant == checksum local   (dégradé en size-only si backend sans checksum)
7. manifest + commit     (phase = committing)
      upload manifest.json à la clé finale  ← marqueur de commit
      move staging → final (rename si supporté, sinon copy+verify+delete)
8. artifact COMMITTED    → BackupArtifact créé, run COMPLETED
9. retention             (phase = retention) — uniquement après 8
      rclone delete --min-age <retentionDays>d, préfixe strict, dry-run par défaut
```

**`partial backup ≠ valid backup`.** Toute erreur en 5, 6 ou 7 ⇒ run `FAILED`, staging supprimé (best-effort), **aucune** rétention.

### Garanties par niveau
- **Atomicité** : dépend du backend. `capabilities().atomicCommit` détermine `commit.mode` dans le manifest (`atomic-rename` | `copy-verify-delete`). Aucun backend n'est supposé atomique.
- **Intégrité** : checksum SHA-256 du payload compressé, recalculé côté distant quand le backend expose un hash ; sinon `rclone size` + niveau de vérification consigné dans le run.
- **Nettoyage** : `try/finally` côté API — suppression du service, des secrets éphémères et du staging, y compris si l'API crashe (job de balayage des runs `RUNNING` expirés au boot).

---

## 5. Modèle de données (Prisma)

```prisma
enum BackupTargetKind { postgres mysql mongodb redis volume }
enum BackupRunStatus  { RUNNING COMPLETED FAILED }
enum BackupRunPhase   { resolving extracting transferring verifying committing retention done }
enum BackupProtocol   { s3 sftp webdav smb gcs azureblob }

model BackupTarget {
  id        String  @id @default(cuid())
  projectId String
  tenantId  String
  nodeId    String            // FK Node — pas de nouveau type de nœud
  kind      BackupTargetKind
  name      String
  createdAt DateTime @default(now())
  @@unique([nodeId, kind])
  @@index([projectId])
}

model BackupDestination {
  id             String  @id @default(cuid())
  projectId      String?
  tenantId       String
  name           String
  protocol       BackupProtocol
  configEncrypted String            // AES-256-GCM, scope "backup"
  basePath       String
  capabilitiesJson Json?            // dernier probe de capacités
  lastTestedAt   DateTime?
  @@index([tenantId])
}

model BackupPolicy {
  id              String  @id @default(cuid())
  targetId        String
  destinationId   String
  strategyId      String
  schedule        String   // manual | daily | weekly
  scheduleHourUtc Int?
  retentionDays   Int
  verification    String   @default("checksum") // size | checksum
  encryptionMode  String   @default("none")
  placementJson   Json?
  timeoutSec      Int      @default(1800)
  maxConcurrency  Int      @default(1)
  enabled         Boolean  @default(true)
  // lease
  lockedBy        String?
  lockExpiresAt   DateTime?
  @@index([targetId])
  @@index([enabled])
}

model BackupRun {
  id          String  @id @default(cuid())
  policyId    String
  status      BackupRunStatus
  phase       BackupRunPhase @default(resolving)
  trigger     String  // manual | scheduled
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  sizeBytes   BigInt?
  errorCode   String?
  errorMessage String?
  taskId      String?
  @@index([policyId, startedAt])
  @@index([status])
}

model BackupArtifact {
  id           String @id @default(cuid())
  runId        String @unique
  targetId     String
  destinationId String
  storageKey   String            // <basePath>/<slug>/<target>/<artifactId>/
  manifestJson Json
  payloadFormat String
  checksumSha256 String
  sizeBytes    BigInt
  engine       String
  engineVersion String
  strategyId   String
  formatVersion Int    @default(1)
  committedAt  DateTime @default(now())
  @@index([targetId, committedAt])
}
```

Notes :
- Aucune FK Prisma sur `Node.config` : la config reste du JSON validé par Zod (contrat existant).
- `BackupTarget.nodeId` en `onDelete: Cascade` : supprimer un nœud supprime ses métadonnées de backup, **jamais** les artifacts distants.
- Index sur `(status, startedAt)` pour le balayage des runs bloqués.

---

## 6. Contrats partagés (web + API)

`packages/shared/src/backup.ts` (nouveau, exporté par le barrel) :

- `BackupProtocolSchema` + `BackupDestinationFieldsSchema` (champs dynamiques par protocole : `endpoint`, `bucket`, `region`, `host`, `port`, `username`, `password`, `basePath`, `useTls`…) — **uniquement des noms de champs**, les valeurs vivent chiffrées côté API.
- `BackupPolicySchema` (schedule, retention, verification, placement).
- `BackupManifestSchema` (Zod) = **contrat de format**. Version `1`. Toute évolution incrémente `formatVersion` et garde un parser rétro-compatible.
- `TargetKind` / `StrategyId` (union string, pas enum fermé : le registry est la source de vérité runtime).

Le front valide avec ces schémas ; l'API revalide. Impossible de diverger.

---

## 7. Module API

`packages/api/src/modules/backup/`

```
engine.ts              BackupEngine (orchestration, lifecycle, retention, lease)
strategies/
  registry.ts          Map<TargetKind, BackupStrategy>
  postgres.ts  mysql.ts  mongodb.ts  redis.ts  volume.ts
storage/
  provider.ts          interface + StorageCapabilities
  rclone-adapter.ts    SEUL fichier autorisé à invoquer rclone
  registry.ts          Map<BackupProtocol, StorageProvider>
manifest.ts            build / parse / validate (Zod partagé)
runner.ts              service Swarm one-shot + attente + cleanup
routes.ts              CRUD + test + run + historique
service.ts             accès données, chiffrement, garde-fous
```

Endpoints :

| Méthode | Route | Rôle |
|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/backup/destinations` | CRUD destination (config chiffrée, **jamais** renvoyée) |
| `POST` | `/api/backup/destinations/:id/test` | **Capability probe** (voir §9) |
| `GET/POST/PATCH/DELETE` | `/api/backup/policies` | CRUD policy |
| `POST` | `/api/backup/policies/:id/run` | run manuel |
| `GET` | `/api/backup/runs` | historique + phases |
| `GET` | `/api/backup/artifacts` | artifacts restaurables (manifest résumé) |
| `GET` | `/api/backup/artifacts/:id` | manifest complet |
| `POST` | `/api/backup/artifacts/:id/restore` | **501 en V1** — contrat réservé, pas de route fantôme |

Garde-fous transverses :
- `configEncrypted` jamais déchiffré en sortie (test explicite miroir `secrets.test.ts`).
- Remote-string jamais loggée, jamais dans `errorMessage` : les erreurs rclone sont **filtrées** avant persistance (regex sur `:user:pass@`, `key=`, `secret=`).
- Toute route scopée tenant (miroir `RegistryCredential`).

### 7.1 Autorisation

Le moteur `can()`/`require()` est mergé mais **aucune route ne l'appelle** (phase 3 non faite). Le module backup ne doit pas inventer un troisième régime d'accès.

- **V1** : middleware tenant existant, identique aux 14 modules actuels.
- **Préparation (même PR, sans effet runtime)** : ajouter les entrées au `catalog/resource-catalog.ts` pour que la phase 3 n'ait pas à rouvrir le domaine backup :

```ts
"backup.destination.read":   tenantLevel,
"backup.destination.set":    tenantLevel,
"backup.destination.delete": tenantLevel,
"backup.policy.read":    entry(["node", "project"], ["tenant", "cluster", "project", "node"], "Node.project.tenantId"),
"backup.policy.create":  entry(["node"], ["project", "node"], "Node.project.tenantId"),
"backup.policy.update":  entry(["node"], ["node"], "Node.project.tenantId"),
"backup.policy.delete":  entry(["node"], ["node"], "Node.project.tenantId"),
"backup.run":            entry(["node"], ["project", "node"], "Node.project.tenantId"),
"backup.artifact.read":  entry(["node", "project"], ["tenant", "cluster", "project", "node"], "Node.project.tenantId"),
"backup.artifact.restore": entry(["node"], ["node"], "Node.project.tenantId"),
```

- Aucun nouveau `ScopeType` : `node` et `project` existent (`scope.ts:15-22`). Une destination reste `tenantLevel` (pas de scope dédié — ce serait une migration de concept pour zéro besoin).
- Le nom `BackupPolicy` évite la collision avec le modèle `Policy` du moteur d'autorisation (`schema.prisma:508`).
- Ne **pas** brancher `require()` sur ces routes en V1 : le faire seulement en phase 3, de façon uniforme sur tous les modules.

---

## 8. Runner one-shot

Image `backup-runner` (GHCR, CI miroir `patroni-build.yml`) :
`alpine` + `rclone` + clients `postgresql-client` / `mysql-client` / `mongodb-tools` / `redis` + `tar` + `gzip` + `sha256sum`.

Le task reçoit :
- réseau overlay du projet → accès DB par DNS Swarm (`ConnectionEndpoint.host`) ;
- Docker Secrets montés en fichiers : `dest_credentials.json` (éphémère) + le secret DB **existant réutilisé par référence** (aucune copie de valeur) ;
- `tmpfs` (1 Mo) pour `.pgpass` / `.my.cnf` / checksum / manifest — **jamais** `PGPASSWORD` en env (`docker service inspect` le lirait) ;
- `cmd` = script interne du strategy plan, `restartPolicy: on-failure(0)`, `resources` bornées, `placement` de la policy.

Garanties : attente bornée par `timeoutSec` (pas de poll infini), collecte des logs, `try/finally` de nettoyage (service + secrets éphémères + staging), label `bozando.system=true` + `bozando.backupRunId` (protégé par `assertNotSystem`).

---

## 9. Test de destination = test de capacité

Séquence réelle, pas un simple ping :

```
authenticate → list (read) → put objet temporaire → stat → hash/read-back → delete
```

Résultat persisté dans `BackupDestination.capabilitiesJson` :

```json
{ "read": true, "write": true, "delete": true, "move": false, "checksum": true, "atomicCommit": false }
```

- Un credential read-only est **détecté** (write=false) et affiché dans le Canvas, au lieu d'échouer au premier backup.
- Timeout court (5 s de connexion) : un NAS injoignable ne bloque pas l'UI.
- Le probe crée et supprime un objet sous `.probe/` uniquement — jamais dans le préfixe des artifacts.

---

## 10. Chiffrement — deux axes distincts

| Axe | V1 | Mécanisme |
|---|---|---|
| Credentials de destination | **Oui** | `encryptSecret(value, "backup")` — extension de `SecretKind` + `BACKUP_ENCRYPTION_KEY` (`secret-encryption-service.ts:21-26`) |
| Données du backup | **Non** (champ réservé) | `BackupEncryptionPolicy` future ; le manifest porte `encryption.mode` dès V1 pour ne pas casser le format |

Le chiffrement des credentials **ne chiffre pas** les archives. Le manifest l'explicite (`"encryption": {"mode":"none"}`), pour qu'aucun opérateur ne suppose une protection inexistante.

---

## 11. Planification, concurrence, nettoyage

- `packages/api/src/jobs/backup-scheduler.ts` : `setInterval` (motif des 3 jobs existants), tick toutes les 60 s, sélection des policies dues (`schedule` + `scheduleHourUtc` + dernier run).
- **Lease en base** (pas d'advisory lock de session, incompatible avec le pooling) :
  ```sql
  UPDATE "BackupPolicy" SET "lockedBy" = $1, "lockExpiresAt" = now() + interval '2 hours'
  WHERE id = $2 AND enabled = true
    AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" < now())
  ```
  `affectedRows = 0` ⇒ une autre instance exécute déjà : skip silencieux. Renouvellement du lease par heartbeat, libération en `finally`.
- Concurrence globale bornée (`maxConcurrency` par policy + plafond process).
- Au boot : balayage des `BackupRun.status = RUNNING` dont le lease est expiré → `FAILED` + cleanup des services/secrets orphelins.
- Rétention : `rclone delete --min-age <N>d` **strictement** sous `<basePath>/<projectSlug>/<targetName>/`, dry-run par défaut, jamais de suppression du `basePath` ni d'un préfixe vide (garde-fou type `prune-orphans`).

---

## 12. Frontend (Canvas)

- `BackupDestinationPanel.tsx` : sélecteur de protocole, champs pilotés par le Zod partagé, bouton « Tester la capacité » avec matrice de résultats (read/write/delete/checksum) et badge par capacité — pas un simple vert/rouge.
- `BackupPolicyPanel.tsx` : destination, schedule, rétention, vérification, placement (obligatoire si protocole `smb`/NAS).
- Intégration dans `DatabaseForm.tsx` / `VolumeForm.tsx` / `ContainerForm.tsx` : section « Sauvegarde » listant les policies du target + dernier artifact (date, taille, checksum court) + historique des runs.
- Un target `database` affiche la stratégie native imposée et grise l'option `volume` avec l'avertissement de cohérence.
- Aucun nouveau type de nœud dans la palette.

---

## 13. Étapes d'implémentation (ordre de dépendance)

1. **Modèle de données** — migration Prisma (§5) + rollback testé.
2. **Contrats partagés** — `packages/shared/src/backup.ts` (protocoles, policy, manifest v1).
3. **Scope de chiffrement** — `"backup"` dans `SecretKind` + `BACKUP_ENCRYPTION_KEY` + tests de rotation.
4. **`StorageProvider` + `RcloneAdapter`** — interface, capabilities, remote-string, `put/get/stat/list/delete/move/hash`, filtre anti-fuite de logs. Testé avec un backend `local` + MinIO.
5. **Registry de stratégies + `postgres.pg_dump`** — première verticale complète (plan → stream → manifest).
6. **`BackupEngine`** — lifecycle, staging, verify, commit, artifact, lease.
7. **Runner one-shot** — `createService`, secrets, tmpfs, attente bornée, cleanup.
8. **Image `backup-runner` + CI** — build versionné, clients DB, vérification `pg_dump >= serveur`.
9. **API** — CRUD destinations/policies, `test` (capability probe), `run`, historique, `restore` 501.
10. **Catalogue d'autorisation** — entrées `backup.*` dans `resource-catalog.ts` (§7.1), sans brancher `require()` (phase 3).
11. **Job scheduler** — `setInterval` + lease + balayage au boot.
12. **Stratégies suivantes** — `mysql`, `mongodb`, `redis`, `volume` (un fichier chacune, zéro modification du moteur).
13. **Frontend** — panneaux + intégration formulaires.
14. **Tests** — voir §15.

---

## 14. Périmètre V1 et non-objectifs

**Inclus :** targets DB (4 moteurs) + volume ; policies multiples par target ; destinations S3/SFTP/SMB/WebDAV/GCS/Azure via Rclone ; Docker Secrets ; zéro disk-fill ; staging/verify/commit ; manifest + checksum ; rétention après commit ; capability probe ; lease anti-double-run ; runner one-shot.

**Exclus (assumés, contrat préservé) :**
- Implémentation du `restore` (interface + manifest prêts, route 501).
- Chiffrement des données de backup (`encryptionMode` réservé).
- Rétention GFS (daily/weekly/monthly), backup incrémental/différentiel.
- Object lock / immutabilité côté backend.
- Restauration point-in-time (WAL / binlogs).

**Critère de réussite architectural :** ajouter `mariadb` ou un backend `local` ne doit toucher **que** `strategies/` ou `storage/` — jamais `engine.ts`.

---

## 15. Tests

**Unitaires (api)**
- `manifest.ts` : build/parse, rétro-compatibilité `formatVersion`, rejet d'un manifest incomplet.
- `rclone-adapter` : échappement remote-string (5 protocoles, caractères spéciaux), aucune fuite de credentials dans les erreurs/logs.
- `engine` : artifact créé **uniquement** après verify+commit ; échec en transfert ⇒ 0 artifact ; échec en verify ⇒ 0 artifact et **0 rétention**.
- `retention` : `--min-age` exécuté après commit uniquement, préfixe borné, refus d'un `basePath` vide/racine.
- `lease` : deux exécutions concurrentes ⇒ une seule passe.
- `capabilities` : backend sans `move` ⇒ commit `copy-verify-delete` ; backend sans `checksum` ⇒ vérification `size` consignée.
- `registry` : ajout d'une stratégie factice ⇒ moteur inchangé (test de non-régression du contrat).

**Intégration (CI, services éphémères — motif `ci.yml`)**
- MinIO (S3) + OpenSSH (SFTP) : backup PostgreSQL réel → artifact listé → manifest valide → checksum vérifié → rétention appliquée.
- Échec réseau en cours de transfert : run `FAILED`, staging absent, service + secrets nettoyés, dernier artifact intact.
- MySQL/MongoDB : au moins un run vert par stratégie (streaming vérifié).

**Frontend**
- Rendu conditionnel des champs par protocole (Zod partagé).
- Matrice de capacités affichée après probe (write=false visible).
- Aucun secret dans le DOM ni dans les réponses réseau (assertion sur le payload).

---

## 16. Checklist pre-merge

- [ ] Migration appliquée + rollback testé.
- [ ] Aucun secret en clair : réponse API, logs, `docker service inspect`, manifest.
- [ ] Aucune archive écrite sur disque (vérification : `df` du nœud stable + absence de volume monté dans le task).
- [ ] `EXEC` et `CONTAINERS` toujours à `0` (`docker-compose.yml:63-64`).
- [ ] Artifact inexistant si transfert/verify/commit échoue ; rétention jamais déclenchée sur échec.
- [ ] `move` non supporté ⇒ commit dégradé explicite, manifest cohérent.
- [ ] Un seul run par policy malgré deux instances API (test de lease).
- [ ] Manifest suffisant pour restaurer **sans Hullbay** (procédure testée à la main sur un artifact PostgreSQL).
- [ ] Ajout d'une stratégie de test ⇒ diff limité à `strategies/` (critère de découplage).
- [ ] Permissions `backup.*` présentes au catalogue, `require()` **non** branché sur les routes (phase 3 uniforme).
- [ ] `npm run typecheck` + `npm test` verts.

---

## 17. Points de vigilance (non négociables)

1. **Ne jamais rouvrir `EXEC`/`CONTAINERS`.** Toute PR utilisant `docker exec` pour un backup est rejetée en revue.
2. **Placement** : un NAS local n'est joignable que depuis le nœud routé → contrainte de placement obligatoire (champ UI), sinon probe et run échouent de façon opaque.
3. **Version client ≥ version serveur** : `pg_dump`/`mysqldump`/`mongodump` plus anciens que le serveur = échec silencieux ou dump invalide. Vérifié en prérequis, pas au milieu du stream.
4. **Cohérence des volumes** : jamais de `tar` d'un datadir de DB vivante en stratégie par défaut. Volume = données génériques ou fallback explicite.
5. **Remote-string** : jamais dans un log, une trace, un message d'erreur ou une réponse HTTP.
6. **Rétention** : bornée au préfixe de l'artifact ; un `basePath` mal saisi ne doit pas pouvoir supprimer hors périmètre.
7. **tmpfs** : `.pgpass`/`.my.cnf`/manifest uniquement en RAM ; `PGPASSWORD` en env est proscrit.
8. **Commit = manifest présent.** Aucun autre critère (exit code 0 n'est pas une preuve).
9. **`partial ≠ valid`** : pas de rétention, pas d'artifact, pas de run `COMPLETED` sur un transfert partiel.
