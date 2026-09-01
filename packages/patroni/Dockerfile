# Image Patroni custom hullbay — une image par version majeure PostgreSQL.
# L'image EST la version : pas de sélection runtime (pas de POSTGRESQL_VERSION).
# Base postgres:<major>-bookworm + Patroni 3.3.0 (pip, etcd3) + entrypoint.
ARG PG_VERSION=17
FROM postgres:${PG_VERSION}-bookworm

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
         "patroni[etcd3]==3.3.0" psycopg2-binary

COPY packages/patroni/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /etc/patroni \
    && chown postgres:postgres /etc/patroni

USER postgres
ENTRYPOINT ["/entrypoint.sh"]
