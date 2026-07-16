# Build du front (Vite) puis service statique via nginx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm install --workspace @bozando-ops/web --workspace @bozando-ops/shared --include-workspace-root
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
RUN npm run build --workspace @bozando-ops/shared
RUN npm run build --workspace @bozando-ops/web

FROM nginx:alpine
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
# SPA fallback : toutes les routes -> index.html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / { try_files $uri /index.html; }\n}\n' \
    > /etc/nginx/conf.d/default.conf
EXPOSE 80
