#!/bin/sh
set -eu

# === Préparation config Patroni ===
# Toutes les valeurs métier arrivent via les env vars PATRONI_* fournies par le
# provider (expansion). Patroni fusionne fichier YAML + env vars (env prioritaire).
# On génère ici UNIQUEMENT la structure finale + le bloc bootstrap (DCS, initdb,
# params PG) qui n'est pas couvert exhaustivement par les env vars.
mkdir -p /etc/patroni
cat > /etc/patroni/config.yml <<YAML
scope: "${PATRONI_SCOPE}"
namespace: "${PATRONI_NAMESPACE}"
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 15
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        wal_level: replica
        hot_standby: 'on'
        max_connections: 100
        max_worker_processes: 8
        max_wal_senders: 10
        max_replication_slots: 10
        hot_standby_feedback: 'on'
        wal_log_hints: 'on'
      # pg_hba : liste fusionnée similaire aux défauts Patroni (trust localhost
      # TCP critique pour post_bootstrap : création rôle superuser + replication
      # AVANT pose des mots de passe — sans ces lignes => "no password supplied").
      # + réplication cross-host pour pg_basebackup des réplicas (overlay privé).
      pg_hba:
        - local all all trust
        - host all all 127.0.0.1/32 trust
        - host all all ::1/128 trust
        - host all all 0.0.0.0/0 md5
        - host replication replicator 0.0.0.0/0 md5
  initdb:
    - encoding: UTF8
    - data-checksums
YAML

# === Permissions data dir ===
# Volume neuf (même Swarm) hérité du montage Docker peut arriver en mode non-0700
# (ex : copie du dir d'image en 1777). initdb chmod 700 son target, mais le flux
# pg_basebackup (réplica) ne corrige PAS le mode du dir racine => postmaster FATAL
# "data directory has invalid permissions". L'image tourne en USER postgres qui
# possède le dir : on force 700 avant tout, sans toucher FILES existants (contraire
# à un initdb qui effacerait le cluster déjà bootstrappé).
if [ -z "${PATRONI_POSTGRESQL_DATA_DIR:-}" ] || [ ! -e "${PATRONI_POSTGRESQL_DATA_DIR}" ]; then
  echo "patroni: PATRONI_POSTGRESQL_DATA_DIR invalide" >&2
  exit 1
fi
chmod 700 "${PATRONI_POSTGRESQL_DATA_DIR}"

# === Secrets (*_FILE) → env Patroni ===
# Patroni (3.3.0) ne connait que PATRONI_*_PASSWORD (user/password inline) : il n'a
# AUCUN support de suffixe *_FILE (grep password_file vide dans son code). Les
# *variateurs* montés en secrets Docker Swarm sont donc lus ici et re-exposés
# sous la forme attendue, SANS jamais les inscrire dans la config service Swarm.
# Rôles concernés : restapi (basik), superuser (créé par post_bootstrap) et
# replication (utilisé par pg_basebackup des réplicas — sans lui, pg_basebackup
# boucle sur "Password: " et le replica ne rejoint jamais le cluster).
for _pwd_var in PATRONI_RESTAPI_PASSWORD PATRONI_SUPERUSER_PASSWORD PATRONI_REPLICATION_PASSWORD; do
  _file_var="${_pwd_var}_FILE"
  _file_val="$(eval "printf '%s' \"\${${_file_var}:-}\"")"
  if [ -n "${_file_val}" ] && [ -f "${_file_val}" ]; then
    export "${_pwd_var}"="$(cat "${_file_val}")"
  fi
done

# === Démarrage Patroni ===
patroni /etc/patroni/config.yml &
PATRONI_PID=$!
trap 'kill "$PATRONI_PID" 2>/dev/null || true' EXIT

# === Attente postgres (superuser) ===
# Patroni ne crée que postgres/template* : la base applicative est créée ci-après.
SUPERUSER="${PATRONI_SUPERUSER_USERNAME}"
DATABASE="${PATRONI_DATABASE}"
export PGPASSWORD="$(cat "${PATRONI_SUPERUSER_PASSWORD_FILE}")"

for _ in $(seq 1 240); do
  kill -0 "$PATRONI_PID" 2>/dev/null || exit 1
  if pg_isready -h 127.0.0.1 -p 5432 -U "${SUPERUSER}" >/dev/null 2>&1; then break; fi
  sleep 2
done

# === Gate primauté ===
# Un standby ou un membre en crash-recovery répond pg_isready sans être writable
# — CREATE DATABASE sur un standby échoue ("cannot run during recovery"). On ne
# tente la création QUE sur le primaire.
if psql -h 127.0.0.1 -p 5432 -U "${SUPERUSER}" -d postgres -Atqc "SELECT pg_is_in_recovery()" 2>/dev/null | grep -qx "f"; then
  if ! psql -h 127.0.0.1 -p 5432 -U "${SUPERUSER}" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='${DATABASE}'" | grep -q 1; then
    if psql -h 127.0.0.1 -p 5432 -U "${SUPERUSER}" -d postgres -qc "CREATE DATABASE \"${DATABASE}\" OWNER \"${SUPERUSER}\""; then
      echo "patroni: base '${DATABASE}' créée"
    else
      echo "patroni: ÉCHEC création base '${DATABASE}'" >&2
    fi
  fi
fi
unset PGPASSWORD

wait "$PATRONI_PID"
