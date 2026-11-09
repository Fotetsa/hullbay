# Backup Engine — restauration manuelle (V1)

La restauration automatique n'est pas livrée en V1 : `POST
/api/backup/artifacts/:id/restore` répond **501** avec `code:
"not_implemented"`. Chaque artifact reste cependant restaurable sans Hullbay,
car le manifest contient tout le nécessaire.

## 1. Récupérer le manifest

```bash
curl /api/backup/artifacts/<artifactId> -H "Authorization: Bearer $TOKEN"
```

Le manifest donne : `strategy.id`, `payload.format`, `payload.sizeBytes`,
`checksum.value`, `restore.command`, et la source (`engine`, `engineVersion`,
`database`). Le payload se trouve à `storageKey` sur la destination.

Récupération via rclone (adapter la remote à la destination) :

```bash
rclone copyto "s3:hullbay-prod/<storageKey>" ./payload
sha256sum ./payload   # doit égaler checksum.value
```

**Toujours vérifier le checksum avant de restaurer.**

## 2. PostgreSQL — `sql.gz`

```bash
gunzip -c payload.sql.gz | psql -h <host> -U <user> -d <database>
```

Le dump est produit avec `--no-owner --no-privileges` : les rôles et
privilèges ne sont pas inclus. Recréer les rôles applicatifs au préalable si
nécessaire.

## 3. MySQL / MariaDB — `sql.gz`

```bash
gunzip -c payload.sql.gz | mysql -h <host> -P 3306 -u <user> -p
```

Le dump inclut `CREATE DATABASE`/`USE` (`--databases`) : la base d'origine est
recréée. Pour restaurer sous un autre nom, retirer ces instructions ou utiliser
`--one-database`.

## 4. MongoDB — `archive.gz`

L'archive est **déjà gzip** (`mongodump --archive --gzip`). Ne pas la
décompresser avant `mongorestore` :

```bash
mongorestore --archive --gzip \
  --uri "mongodb://<user>:<password>@<host>:<port>/<database>?authSource=admin" \
  < payload.archive.gz
```

## 5. Redis — `rdb.gz`

```bash
gunzip -c payload.rdb.gz > dump.rdb
redis-check-rdb dump.rdb   # doit afficher « RDB looks OK »
```

Arrêter Redis, remplacer son `dump.rdb` par ce fichier (droits du user redis),
puis redémarrer. Redis charge le RDB au démarrage.

## 6. Volume — `tar.gz`

```bash
mkdir -p /restore
tar -xzf payload.tar.gz -C /restore
```

L'archive contient le contenu du volume à sa racine (`tar -C <mount> .`).
Restaurer dans un volume vide, service arrêté, pour éviter un mélange d'états.

## 7. Après restauration

1. Vérifier les données (comptages, dernières écritures).
2. Redémarrer les services qui utilisent la source.
3. Consigner l'artifact utilisé (`artifactId`, `runId`, checksum) dans le
   journal d'incident.

## Rappels

- Un artifact `COMPLETED` sans manifest ne doit pas exister : le manifest est
  le marqueur de commit.
- Un run `FAILED` ne produit **aucun** artifact ; ne jamais restaurer un objet
  trouvé dans `.staging/`.
- Le format est versionné (`formatVersion`). Un manifest de version future est
  refusé par Hullbay : utiliser la version d'Hullbay qui l'a produit.
