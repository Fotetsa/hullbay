# Image du runner de sauvegarde Hullbay.
#
# Un seul binaire de transfert (rclone) + les clients des moteurs supportés.
# Aucun état : le task Swarm est éphémère, aucune archive n'est écrite sur le
# disque du nœud (extraction → gzip → rclone rcat en streaming).
#
# Base Debian et non Alpine : le client MariaDB d'Alpine ne sait pas charger le
# plugin `caching_sha2_password` utilisé par MySQL 8 par défaut. Le client
# Debian s'y connecte sans configuration serveur.
#
# Version du client PostgreSQL : elle doit être >= la majeure du serveur.
# Le script de prérequis de la stratégie refuse le run sinon (pas de dump
# silencieusement invalide).
FROM debian:bookworm-slim

ARG MONGO_TOOLS_VERSION=100.9.4
# rclone récent : Debian bookworm fournit 1.60, qui n'a pas `serve s3` ni les
# correctifs SMB/WebDAV récents. Binaire officiel, version figée.
ARG RCLONE_VERSION=1.71.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      curl \
      default-mysql-client \
      gnupg \
      gzip \
      redis-tools \
      tar \
      tzdata \
      unzip \
    # PostgreSQL 16 : absent de bookworm, fourni par le dépôt PGDG.
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    # Database Tools MongoDB (mongodump/mongorestore) : distribution officielle.
    && curl -fsSL "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-${MONGO_TOOLS_VERSION}.tgz" \
      | tar -xz -C /usr/local --strip-components=1 \
    # rclone officiel (version figée ci-dessus).
    && curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" \
      -o /tmp/rclone.zip \
    && unzip -q /tmp/rclone.zip -d /tmp/rclone \
    && install -m 0755 /tmp/rclone/rclone-*-linux-amd64/rclone /usr/local/bin/rclone \
    && rm -rf /tmp/rclone /tmp/rclone.zip \
    && apt-get purge -y curl gnupg unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# bash est requis par le runner (process substitution pour le checksum en flux).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN groupadd -r hullbay && useradd -r -g hullbay -d /home/hullbay -m hullbay
USER hullbay
WORKDIR /home/hullbay

# La commande est fournie par le service Swarm (cmd = script one-shot).
