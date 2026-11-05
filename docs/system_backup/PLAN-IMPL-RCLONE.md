# Plan d'Implémentation — Système de Sauvegarde Multi-Protocoles (Rclone)

**Statut :** Plan — analyse factuelle du codebase (`upstream/master` @ `e52e5f7`).
**Méthode :** Investigation directe du dépôt (schéma Prisma, modules API, workflows, docker-compose, schemas Zod partagés, canvas web, jobs).

---

## 1. Contexte & objectifs

Hullbay est une plateforme PaaS open-source et auto-hébergée sur Docker Swarm. L'objectif de cette évolution est de fournir un système de sauvegarde des bases de données et volumes des projets déployés, avec les propriétés suivantes :

1. **Support multi-protocole :** S3 (AWS / MinIO / R2), SFTP/SSH (VPS, Hetzner Storage Box), WebDAV (Nextcloud, ownCloud), SMB (NAS Synology/TrueNAS), GCS, Azure Blob.
2. **Architecture "Zero-Disk-Fill" :** les archives ne transitent jamais par le disque des nœuds Swarm — streaming direct de `pg_dump` / `tar` vers la destination distante.
3. **Dette technique minimale :** transfert, test de connexion et rotation unifiés sous un seul moteur (Rclone), pas de connecteurs individuels par protocole.
4. **Simplicité Canvas :** configuration visuelle avec validation instantanée de la connexion.

**Choix du moteur : Rclone.** Binaire statique Go, licence MIT (identique à Hullbay), +70 protocoles couverts par une seule implémentation, archives au format standard (`.sql.gz`, `.tar.gz`) récupérables manuellement sans Hullbay, pilotage sans fichier de configuration sur l'hôte (remote-string dynamique).

---

## 2. État des lieux du codebase (faits bruts)

Le système de sauvegarde est **neuf** — aucun composant backup, S3 ou rclone n'existe aujourd'hui dans le dépôt. En revanche, l'infrastructure nécessaire à son implémentation est déjà largement en place :

### 2.1 Données & multi-tenancy
- `Node.type` = `container | network | volume | gateway` ; un `Node` porte un `dockerId`/`actualState` observés (contrat "ressource Docker déployée"). `packages/api/prisma/schema.prisma:35-61`
- Modèles tenant-scoped existants : `Server` (`privateKeyEnc`), `RegistryCredential` (`tokenEnc`). `schema.prisma:283-324`
- Le mot de passe d'une base n'est **jamais** dans le config JSON du nœud : uniquement une **référence** `passwordSecretRef` → Docker Secret monté en fichier. `node-config.ts:312`, `database/providers/postgres.ts:248-260`

### 2.2 Exécution Swarm disponible
- `createService(name, config, labels, networks, mounts)` opérationnel, avec `resolveSecretRefs` interne. `docker-engine/service.ts:730-746`
- `buildServiceSpec` supporte déjà : placement constraints + spread (`:657-667`), `restartPolicy` (`:654`), `cmd` exec-form (`node-config.ts:141-142`).
- Secrets Swarm montés en `/run/secrets/<name>` : pattern PostgreSQL (`node-config.ts:126-133`, `postgres.ts:248-252`).
- L'API pilote Swarm via TCP : `DOCKER_HOST=tcp://socket-proxy:2375` (`docker-compose.yml:91`). Le socket-proxy verrouille volontairement `EXEC:0` et `CONTAINERS:0` (`docker-compose.yml:62-64`).

### 2.3 Chiffrement & SSH
- Façade `encryptSecret`/`decryptSecret` AES-256-GCM opérationnelle (scope "mfa" aujourd'hui). `modules/auth/crypto.ts:11-14`, `lib/keys.ts`
- SSH `ssh2` avec TOFU anti-MITM + clé-outil éphémère en mémoire. `lib/ssh.ts:1-40`

### 2.4 Jobs, rétention, UX
- Scheduler = `setInterval` enregistré depuis le serveur (3 jobs : cluster-health:152, reconcile-drift:46, auto-scaler:141). Aucune lib cron dans les dépendances.
- Référentiel de garde-fous rétention : dry-run par défaut, interdiction de toucher `bozando.system=true`. `prune-orphans.ts:1-45`
- Canvas : un seul type de nœud (`ops: OpsNode`), formulaires dédiés dans `packages/web/src/canvas/forms/` (ContainerForm, DatabaseForm), palette dédiée. `CanvasPage.tsx:47`
- Les secrets des services sont posés par `secretsStep` **avant** `servicesStep`. `workflows/deploy-project.ts:273,608`
- Aucun endpoint "test de connexion" n'existe aujourd'hui.

---

## 3. Architecture retenue

L'API ne peut pas exécuter `docker exec` (verrou socket-proxy, volontaire et documenté — cf. §2.2), et il n'existe aucun composant "agent" permanent dans la stack. Le système de sauvegarde s'appuie donc sur des **tâches Swarm éphémères** pilotées par l'API via `createService`, sans nouveau daemon ni réouverture du proxy.

### D1 — Véhicule d'exécution : service Swarm one-shot (task éphémère)
- `docker exec` est verrouillé au proxy (`EXEC:0`, `docker-compose.yml:63`) — verrou de sécurité volontaire qui ne sera **pas** rouvert.
- Un daemon "agent" ajouterait une surface de sécurité permanente + coordination + healthcheck pour un usage **ponctuel**.
- `createService` + placement constraints + `cmd` + secrets existent déjà (`service.ts:730`, `:657-667`) → le task one-shot se leverage sans nouveau code d'orchestration.
- Le task rejoint le réseau overlay du projet → accès à la base par DNS de service Swarm, sans toucher l'hôte.

### D2 — Image dédiée `backup-runner` (rclone + client PostgreSQL + tar)
- `pg_dump` doit provenir d'une image connue ; l'image patroni contient le serveur mais pas rclone, l'image rclone ne contient pas `pg_dump`. Une seule image = pipeline reproductible, versionné en CI (miroir du build patroni, `postgres.ts:50-55`).
- Alternative SSH vers le nœud rejetée : exigerait un binaire rclone déployé sur chaque nœud hôte + transport des creds au-delà de la frontière SSH — plus de surface, plus d'ops, contredit le "stateless".
- Le client `pg` de l'image doit être **≥ version du serveur** (garde-fou à valider au build, cf. §6).

### D3 — Streaming "Zero-Disk-Fill" : pipe interne `pg_dump | gzip | rclone rcat` dans le task, aucun volume persistant monté
- Le task ne monte que son filesystem éphémère + éventuellement un tmpfs RAM : le disque du nœud n'est jamais écrit.
- Un volume local pour l'archive recréerait le problème visé (saturer le disque) et entrerait en conflit avec la gestion volumes existante (`volumesStep` / `prune-orphans`).
- `rclone rcat` accepte stdin → le flux part directement vers la destination distante.

### D4 — Identifiants : jamais dans `Spec.Args` ni `Spec.Env` → Docker Secrets montés en fichiers dans le task
- `SERVICES:1` sur le proxy (`docker-compose.yml:52`) : quiconque a l'API Docker peut lire `docker service inspect` → **tout secret placé en env/args est lisible**.
- Le pattern est déjà en place : `ContainerConfigSchema.secrets` = références seulement, valeurs posées via API, montées `/run/secrets/<name>` (`node-config.ts:126-133`, `postgres.ts:248-252`).
- Même logique pour la DB source : le task reçoit la **référence** du secret existant (`passwordSecretRef`) et génère un fichier `.pgpass` en tmpfs — `PGPASSWORD` en env serait lisible via inspect, donc proscrit.
- Le remote-string rclone (contenant les creds) est **construit en mémoire dans le task** à partir des fichiers secrets, jamais écrit sur disque — doctrine identique à `lib/ssh.ts:12` ("jamais écrits sur disque").

### D5 — Stateless : remote-string dynamique `:protocol,params:base_path` (zéro `rclone.conf` sur hôte)
- Aucun fichier de config contenant des secrets n'est créé sur le disque hôte ni dans l'image.
- `rclone obscure` s'exécute **dans le task** (mémoire), pas sur l'API host.
- Formats d'archives **standards** (`.sql.gz`, `.tar.gz`) : récupération manuelle possible sans Hullbay.

### D6 — Modèle de données : `BackupDestination` + `BackupRun` en entités Prisma dédiées, sans 5ᵉ type de nœud Node
- Un `Node` est contractuellement une ressource Docker observée (`dockerId`, `actualState`, `desiredHash` — `schema.prisma:35-61`). Une destination de sauvegarde n'est **pas** déployée dans Swarm : la modéliser comme `Node` violerait ce contrat.
- Ajouter un type `backup` toucherait au minimum : Zod partagé, matrice de compatibilité (`node-config.ts:322`), Palette, OpsNode, observer, reconciler, expandDatabaseGraph — 6+ points de couplage pour zéro valeur fonctionnelle.
- Miroir du précédent `RegistryCredential` (identifiants distant chiffrés, tenant-scoped, `schema.prisma:311-324`) : cohérence du modèle existant.
- `BackupRun` (historique : status, durée, taille, erreur) est nécessaire car aucune notion d'exécution de sauvegarde n'existe dans `modules/observability`.
- Liaison source → destination : le nœud `database`/`container` **référence** `destinationId` dans son config (champ optionnel Zod), comme il référence déjà `passwordSecretRef`.

### D7 — Chiffrement : réutiliser `encryptSecret`/`decryptSecret` (scope dédié `"backup"`), zéro crypto maison
- La façade AES-256-GCM existe et audite déjà `mfaSecretEnc`, `Server.privateKeyEnc`, `RegistryCredential.tokenEnc`. Un second mécanisme = dette de sécurité. Nouveau scope = isolation des rotations de clé sans casser le scope mfa.

### D8 — Planification : job `backup-scheduler.ts` en `setInterval`, aucune lib cron
- 3 jobs utilisent déjà ce motif enregistré depuis le serveur ; une dépendance cron contredirait la stack actuelle (zéro dépendance inutile) et le principe de moindre modification.

### D9 — Rétention unifiée : `rclone delete --min-age <N>d` post-succès + historique `BackupRun`
- SFTP/WebDAV/SMB n'ont **aucune** lifecycle native — une seule commande rclone couvre les 70+ backends, une seule implémentation à tester.
- Exécution **seulement après succès** du backup (un échec ne doit jamais déclencher de suppression).
- Garde-fous miroir `prune-orphans` : dry-run par défaut, périmètre strict par préfixe `<service_name>/` — jamais de suppression globale du `base_path`.

### D10 — Test de connexion : `POST /api/backup-destinations/:id/test` → task one-shot `rclone lsd --contimeout 5s`
- Même véhicule que D1 (pas de `docker exec`, pas de code réseau côté API).
- Timeout 5s empêche un Canvas bloqué par un hôte injoignable (problème déjà traité côté SSH via `connectTimeoutMs`, `lib/ssh.ts:33-41`).
- Premier endpoint "test de connexion" du dépôt → à documenter comme tel.

---

## 4. Étapes d'implémentation (ordre imposé par les dépendances)

### Étape 1 — Modèle de données (backend)
`packages/api/prisma/schema.prisma` :
- `BackupDestination` : `id`, `name`, `projectId`, `tenantId` (miroir `RegistryCredential:311-324`), `protocol` (enum : `s3 | sftp | webdav | smb | gcs | azureblob`), `configEncrypted` (TEXT — JSON chiffré via scope `"backup"`), `basePath`, `retentionDays` (INT), timestamps.
- `BackupRun` : `id`, `destinationId` (FK), `status` (`running | success | failed`), `startedAt`, `finishedAt`, `sizeBytes`, `error`, `archiveName`.
- Relation source→destination : champ optionnel `backupDestinationId` dans le config Zod des nœuds `database` et `container` (voir Étape 2) — **pas** de FK Prisma sur `Node` (config = JSON validé par Zod, contrat existant).

**Raison de l'ordre :** tout le reste (API, runner, UI) dépend des types générés par la migration.

### Étape 2 — Schemas partagés (validation web + API)
`packages/shared/src/node-config.ts` (et exports) :
- `BackupProtocolSchema`, `BackupDestinationFieldsSchema` (champs dynamiques par protocole), extension `DatabaseConfigSchema`/`ContainerConfigSchema` avec `backupDestinationId: z.string().optional()`.
- **Raison :** validation unique et partagée — pattern exact de toute la config nœud aujourd'hui (`node-config.ts:1-149`).

### Étape 3 — Chiffrement scope `"backup"`
`packages/api/src/modules/auth/secrets/secret-encryption-service.ts` + `crypto.ts` : exposer `encryptSecret(value, "backup")` / `decryptSecret(value, "backup")`.
**Raison :** réutilisation du mécanisme audité (D7), isolation du scope pour rotation future.

### Étape 4 — Module API `backup` (CRUD + test + run)
`packages/api/src/modules/backup/{routes.ts,service.ts}` :
- CRUD destinations (config chiffrée à l'écrit, **jamais** déchiffrée en réponse API — miroir `secrets.test.ts:304-307` qui vérifie l'absence de la valeur dans la réponse).
- `POST /:id/test` → task one-shot `rclone lsd` (D10).
- `POST /:id/run` → task one-shot de backup (D1-D4), création `BackupRun`, collecte d'état.
- Construction du remote-string : fonction pure `buildRcloneRemoteString(dest)` **durcie** : échappement strict, et **interdiction** de logger la chaîne complète (les params contiennent les creds).
**Raison :** cohérence module = `modules/<domain>/{routes,service}` (14 modules existants).

### Étape 5 — Image `backup-runner` + CI
- `packages/backup-runner/Dockerfile` : base alpine + binaire rclone + client PostgreSQL (version majeure ≥ serveur cible) + tar.
- Workflow CI miroir du build patroni (`postgres.ts:50-55` : tags versionnés publiés sur GHCR).
**Raison :** image versionnée = reproductibilité ; miroir patroni = pattern CI déjà en place. **Validation au build** : le backend rclone `smb` est pur Go (aucun `cifs-utils` requis) — à confirmer au build de l'image, cf. §6.

### Étape 6 — Exécutor one-shot (cœur technique)
`packages/api/src/modules/backup/runner.ts` :
- Pour un backup : résolution des références de secrets (dest + source `passwordSecretRef`), création des Docker Secrets Swarm éphémères, `createService` avec : image `backup-runner`, `cmd` = script pipe interne, `restartPolicy = on-failure(0)` (one-shot), placement constraints (voir §5), réseau overlay du projet, label `bozando.system=true` + `bozando.backupRunId`.
- Attente de complétion par inspection des task states (**timeout configurable**, pas de poll infini), collecte des logs du task, nettoyage du service + des secrets éphémères (try/finally).
**Raison :** `createService`/`resolveSecretRefs`/placement existent (`service.ts:730,657-667`) — on parameterise l'orchestration existante, on ne la réécrit pas. Label système = protection `assertNotSystem` existante (`service.ts:749-758`).

### Étape 7 — Job de planification
`packages/api/src/jobs/backup-scheduler.ts` : motif `setInterval` identique aux 3 jobs existants, itère les `BackupDestination` avec planification, appelle l'exécutor, applique la rotation **après succès uniquement** (D9).
**Raison :** D8 + D9.

### Étape 8 — Frontend (Canvas / formulaires)
`packages/web/src/canvas/forms/` :
- `BackupDestinationPanel.tsx` : sélecteur de protocole, champs dynamiques (Zod shared = source de vérité), bouton "Tester la connexion" (appel `POST /:id/test`, badge vert/rouge).
- Intégration dans `DatabaseForm.tsx` / `ContainerForm.tsx` : champ sélection de destination + planification.
- **Raison :** pas de 5ᵉ type de nœud (D6) ; formulaire dynamique piloté par le même Zod partagé = impossible de diverger web/API.

### Étape 9 — Tests
- **Unitaires (api)** : `buildRcloneRemoteString` (échappement, 5 protocoles), rotation (`--min-age` exécuté après succès, jamais après échec), garde-fous rétention, réponse API sans secrets en clair.
- **Intégration** : services de CI (miroir du pattern Postgres de `ci.yml`) — MinIO (S3) + OpenSSH (SFTP) ; exécution réelle d'un backup local → distante + rotation.
- **Frontend** : rendu conditionnel des champs par protocole (mirer les tests forms existants).
**Raison :** le pattern CI "services éphémères + migrations + tests" est déjà établi dans `ci.yml` — même structure, mêmes env.

---

## 5. Points de vigilance (découverts dans le code, non négociables)

1. **Ne jamais rouvrir `EXEC`/`CONTAINERS` sur le socket-proxy** (`docker-compose.yml:62-64`). Toute approche passant par `docker exec` pour le backup est à rejeter en revue.
2. **Placement SMB/NFS** : un NAS local n'est joignable que depuis le nœud sur lequel il est routé. Le task doit porter une **contrainte de placement** documentée (champ UI à prévoir), sinon le test de connexion échouera en mode opaque.
3. **`pg_dump` versionné** : client < serveur = échec. Soit une image multi-majeures, soit résolution de la majeure depuis le config du nœud database avant lancement du task.
4. **Logs & erreurs** : le remote-string ne doit **jamais** figurer dans un log, une trace d'erreur ou une réponse HTTP (les params contiennent les mots de passe).
5. **Périmètre de rotation** : `rclone delete` strictement limité au préfixe `<basePath>/<service_name>/` — un `basePath` mal renseigné ne doit pas pouvoir supprimer hors préfixe (garde-fou type `prune-orphans`).
6. **Tmpfs pour `.pgpass`** : `PGPASSWORD` en env du task serait lisible via `docker service inspect` (cf. D4).

---

## 6. Checklist de validation (pre-merge)

- [ ] Migration Prisma appliquée + rollback testé.
- [ ] Aucune valeur secrète en clair : réponse API, log, `docker service inspect` (test explicite).
- [ ] Backup S3 (MinIO) + SFTP (OpenSSH) en CI : run vert, archive lisible, rotation appliquée.
- [ ] Échec réseau : `BackupRun.status = failed`, **aucune** rotation exécutée, service + secrets éphémères nettoyés.
- [ ] Task one-shot : `restartPolicy` ne boucle jamais ; timeout d'attente respecté.
- [ ] Image `backup-runner` : `smb` backend fonctionnel sans package hôte (validation D5).
- [ ] Garde-fous : impossible de cibler un label `bozando.system=true` ; rotation bornée au préfixe.
- [ ] `npm run typecheck` + `npm test` verts (miroir CI).
