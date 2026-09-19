# Image Patroni custom hullbay — une image par version majeure PostgreSQL.
# L'image EST la version : pas de sélection runtime (pas de POSTGRESQL_VERSION).
# Base postgres:<major>-bookworm ; la version Patroni est un ARG (défaut = pin
# courant). Le workflow dédié (patroni-build.yml, dispatch) la bumper à la volée.
ARG PG_VERSION=17
ARG PATRONI_VERSION=4.1.5
FROM postgres:${PG_VERSION}-bookworm

# ARG re-déclaré SANS valeur après FROM : hérite de la valeur globale (ou du
# --build-arg CI). Obligatoire pour l'utiliser dans les RUN (scope post-FROM).
ARG PATRONI_VERSION

# curl nécessaire au healthcheck Docker du provider (curl -fsS :8008/health).
# python3/pip pour installer Patroni ; ca-certificates pour TLS vers etcd/GHCR.
# Acquire::Retries : réseaux lents/instables (miroirs), réduit les échecs flaky.
# --break-system-packages : image dédiée mono-app (Patroni) — PEP 668 (bookworm
# "externally-managed") interdit le pip global ; un venv n'apporterait rien ici.
RUN apt-get update \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=10 -o Acquire::http::Timeout=120 \
         python3 python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir --retries 10 --timeout 300 \
         "patroni[etcd3]==${PATRONI_VERSION}" psycopg2-binary

COPY packages/patroni/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /etc/patroni \
    && chown postgres:postgres /etc/patroni

USER postgres
ENTRYPOINT ["/entrypoint.sh"]
