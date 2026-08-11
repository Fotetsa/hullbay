# Build de l'api ops-panel (monorepo workspaces : contexte = racine hullbay).
FROM node:22-alpine AS base
WORKDIR /app

# postgresql-client 16 : pg_dump/pg_restore embarqués pour le backup/rollback
# des mises à jour self-hosted (le dump se fait depuis le conteneur API, pas via
# docker exec — le socket-proxy bloque EXEC). Version alignée sur le serveur
# postgres:16 : un client plus récent émet des SET de GUC inconnues du serveur
# (ex. transaction_timeout, PG17+) que pg_restore ne sait pas ignorer.
RUN apk add --no-cache openssl postgresql16-client

# Manifests pour installer les workspaces avec cache
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm install --workspace @hullbay/api --workspace @hullbay/shared --include-workspace-root

# Sources
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api

RUN npm run build --workspace @hullbay/shared

# Client Prisma + build TS
RUN npx prisma generate --schema packages/api/prisma/schema.prisma
RUN npm run build --workspace @hullbay/api

EXPOSE 4000
# Au démarrage : applique les migrations Prisma (idempotent) puis lance le serveur.
# `migrate deploy` n'exécute que les migrations déjà committées (pas de prompt).
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/api/prisma/schema.prisma && node packages/api/dist/server.js"]
