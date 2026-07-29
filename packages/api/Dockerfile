# Build de l'api ops-panel (monorepo workspaces : contexte = racine hullbay).
FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache openssl

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
