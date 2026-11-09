# Backup Engine — architecture

Sauvegarde des données persistantes d'un projet Hullbay (bases de données et
volumes), vers un stockage distant, sans jamais écrire d'archive sur le disque
d'un nœud.

## Couches

```
PersistentDataTarget → BackupPolicy → BackupEngine → BackupStrategy
                                                  → BackupArtifact → StorageProvider → RcloneAdapter
```

| Couche | Rôle | Emplacement |
|---|---|---|
| Target | projection d'un nœud `database`/`volume` | `packages/api/src/modules/backup/targets.service.ts` |
| Policy | intention : cible + destination + planification | `policies.service.ts`, `BackupPolicyInputSchema` |
| Engine | cycle de vie, staging, vérification, commit | `engine/lifecycle.ts` |
| Strategy | plan d'extraction par moteur | `strategies/*.ts` |
| Runner | tâche Swarm one-shot (jamais `docker exec`) | `runner.ts`, `engine/swarm-task.ts` |
| Storage | `put/get/stat/list/delete/move/hash/commitPayload` | `storage/*.ts` |
| Artifact | payload + manifest + checksum | `BackupArtifact` |

Le moteur ne connaît ni rclone ni une stratégie concrète : un test
d'architecture (`strategies.test.ts`) grep les sources et échoue si cette
frontière est franchie.

## StorageProvider vs StagingSink

Deux contrats distincts, à ne pas confondre :

```
Backup Engine
    ↓
Backup Strategy
    ↓
Backup Artifact
    ↓
StorageProvider        ← contrat durable (put/get/stat/list/delete/move/hash/commit)
    ↓
provider adapter       ← SwarmStorageProvider, futur provider natif
    ↓
Rclone / backend réel
```

- **`StorageProvider`** décrit les opérations durables sur un artifact :
  métadonnées, vérification, promotion, suppression. C'est le seul contrat que
  le Backup Engine connaît.
- **`StagingSink`** est la primitive d'**exécution** du streaming
  (`stagingUploadScript`, `remoteString`, `transportSecret`). Elle est fournie
  par l'adapter Swarm pour composer `extraction | upload` dans une tâche
  one-shot, sans écrire d'archive locale. Un futur provider natif (API HTTP,
  SDK cloud) n'a pas à implémenter des commandes shell : il fournira sa propre
  primitive de streaming.

## Capacités

`StorageCapabilities` décrit ce que le backend **garantit réellement**, jamais
ce que Hullbay sait émuler :

- la matrice provient du dernier probe de la destination ;
- sans probe, les capacités valent `false` (`UNPROBED_CAPABILITIES`) ;
- un backend sans checksum natif expose `checksum: false`, même si le commit
  dégrade en vérification de taille ;
- `atomicCommit` signifie « `rclone moveto` a réussi », pas « rename
  physiquement atomique garanti » : selon le backend, rclone peut émulter le
  déplacement par copie+suppression. Le mode réellement exécuté est consigné
  dans `commit.mode`.

Les fallbacks (`copy-verify-delete`, vérification par taille) restent de la
logique du provider et ne sont jamais annoncés comme des capacités.

## Cycle de vie d'un run

`resolving → extracting → transferring → verifying → committing → done`

1. **resolving** : résolution de la connexion (provider du moteur), prérequis
   (`verifyPrereqs`), construction du plan.
2. **extracting/transferring** : `pg_dump`/`mysqldump`/`mongodump`/`redis-cli`/`tar`
   écrit sur stdout → `gzip` → commande d'upload fournie par le `StagingSink`
   vers un préfixe de **staging** propre au run (`.staging/<runId>`). Le
   checksum et la taille sont calculés pendant le flux (process substitution),
   sans fichier intermédiaire.
3. **verifying** : la taille est toujours relue côté distant via le
   `StorageProvider`. Le checksum est comparé en plus quand la politique le
   demande **et** que le backend expose un hash natif ; sinon la vérification
   est explicitement dégradée en taille, jamais silencieusement.
4. **committing** : `commitPayload()` promeut le staging vers le préfixe final
   (`atomic-rename` ou `copy-verify-delete` selon le backend), puis
   `payload.sha256`, puis `manifest.json` **en dernier**.
5. **done** : le run passe `COMPLETED`, l'artifact existe.

Règles non négociables :

- **partial ≠ valid** : aucun artifact ni `COMPLETED` sur un flux incomplet ;
- **pas de manifest → pas d'artifact** : si un échec survient après la
  promotion du payload (checksum, manifest, écriture en base), le préfixe final
  est annulé (manifest supprimé en premier) ;
- le staging est purgé en cas d'échec (bloc `catch`) et supprimé par le commit
  en cas de succès ;
- la rétention ne s'exécute qu'après un run `COMPLETED`.

## Modèle de données

`BackupTarget` (1) — `BackupPolicy` (N) — `BackupRun` (N) — `BackupArtifact` (0..1)

- `BackupDestination` porte le chiffré (AES-256-GCM, scope `backup`) et une
  matrice de capacités issue du dernier probe.
- `BackupPolicy` porte le lease (`lockedBy`, `lockExpiresAt`) : un seul runner
  planifié à la fois, sans verrou consultatif (Prisma pooling).
- `BackupArtifact.sizeBytes` est un `BigInt` ; l'API le sérialise en chaîne.

## Manifest

Le manifest est auto-descriptif et suffit à restaurer sans Hullbay :

- identité (`artifactId`, `runId`, `createdAt`) ;
- cible (`nodeId`, `name`, `kind`) et source (`engine`, `engineVersion`,
  `database`) — aucun hôte, port ou utilisateur ;
- stratégie et outil (`id`, `version`, `tool`, `toolVersion`) ;
- payload (`path`, `format`, `sizeBytes`) ;
- checksum (`sha256`) et mode de vérification (`mode`, `downgraded`) ;
- mode de commit réellement exécuté (`commit.mode`) ;
- commande de restauration standard.

`parseBackupManifest` refuse un `formatVersion` futur au lieu de l'interpréter.

## Sécurité

- Aucun `docker exec` : un service Swarm one-shot par étape, supprimé ensuite.
- Credentials uniquement en Docker Secrets montés en fichiers ; les scripts
  construisent `.pgpass`/`.my.cnf`/`mongodump.yaml` **dans le task**.
- Les mots de passe SFTP/WebDAV/SMB sont **obscurcis** (`rclone obscure`) dans
  la connection-string : rclone refuse un `pass=` en clair.
- Jamais de mot de passe en `Env`, `Args`, log, réponse HTTP ou manifest.
- Les logs de task sont nettoyés (`scrubSecrets`) avant persistance.
- Destinations : lecture = operator (vue sans secret), mutation et probe = owner.

## Limites V1

- Restauration automatique non implémentée (`POST .../restore` → 501) ; la
  procédure manuelle est documentée dans [restauration.md](restauration.md).
- `StorageProvider.get()` n'est pas implémenté pour le backend Swarm : le
  contrat existe pour ne pas verrouiller le format, mais la lecture en
  streaming d'un artifact sera câblée avec l'orchestration du restore.
- `StorageProvider.put()` est réservé aux **petits objets de métadonnées**
  (manifest, checksum). Le backend Swarm bufferise un `Readable` ; le payload
  de backup ne passe jamais par `put()`, il est streamé via `StagingSink`.
- Chiffrement du payload : `encryptionMode = "none"` uniquement (le chiffrement
  des *credentials* est distinct).
- Cibles : nœuds `database` et `volume`. Un conteneur n'expose pas de source
  cohérente et est refusé explicitement.
- Un volume marqué `bozando.database.data=true` est refusé par défaut
  (`BACKUP_ALLOW_DATABASE_VOLUME=true` pour un override opérateur explicite,
  consigné dans les logs).
