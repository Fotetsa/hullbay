# Contributing to hullbay

Thank you for considering a contribution to hullbay. This guide outlines the development setup, contribution flow, and quality checks expected for changes to the project.

## Code of conduct

By participating in this project, you agree to respect its code of conduct and to contribute in a constructive and respectful manner.

## Reporting an issue

Before opening an issue, please check whether it already exists in the GitHub issue tracker. Include the following details when relevant:

- steps to reproduce
- expected behavior versus observed behavior
- Node and Docker versions
- relevant logs, with secrets removed

## Proposing a feature

If you want to propose a new capability or workflow, open an issue first to describe the use case and the expected outcome before starting implementation.

## Development environment

### Prerequisites

- Node.js 20 or newer with npm
- A local Docker daemon
- PostgreSQL and Redis for local development

### Start infrastructure dependencies

For local development, only the supporting services are started in containers. The API and web applications run from the workspace in watch mode.

```bash
docker compose up -d postgres redis
```

### Environment variables

```bash
cp .env.template .env

# Generate the master secrets
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> MFA_ENCRYPTION_KEY
```

Common local development values are already documented in the template file:

| Variable | Local development value |
|---|---|
| API_PORT | 4000 |
| WEB_ORIGIN | http://localhost:5273 |
| REDIS_URL | redis://localhost:6379 |
| DATABASE_URL | postgresql://ops:...@localhost/hullbay |
| DOCKER_HOST | leave empty to use the Unix socket by default |

The DOCKER_SOCKET_PATH variable is only needed for non-standard socket paths.

### Install dependencies and prepare the database

```bash
npm install
npm run prisma:generate --workspace @hullbay/api
npm run prisma:migrate --workspace @hullbay/api
```

Do not edit Prisma migration files manually. Use Prisma migration commands for schema changes.

### Start the development servers

Run the following in two separate terminals from the repository root:

```bash
npm run predev --workspace @hullbay/shared
npm run dev --workspace @hullbay/api
npm run dev --workspace @hullbay/web
```

The web app runs on port 5273 and calls the API on port 4000. The first launch of the UI should guide you through the bootstrap flow to create the initial owner account.

### Verify the development gateway

The API drives Caddy through its admin API (`http://localhost:2019` in dev — see
`CADDY_ADMIN_URL` in `packages/api/.env`). Before exercising any gateway or
domain-setup flow locally, ensure the overlay network and a reachable Caddy
admin exist:

```bash
docker network create -d overlay --attachable boz_system || true   # already created by install.sh

docker run -d --name boz-caddy-dev \
  --network boz_system \
  -p 2019:2019 -p 80:80 \
  -e PUBLIC_HOST=:80 \
  -v "$(pwd)/Caddyfile":/etc/caddy/Caddyfile:ro \
  caddy:2-alpine
```

Then verify the admin API:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:2019/config/
```

The expected result is 200. If the save-domain step fails with
`getaddrinfo EAI_AGAIN caddy`, the API tries to reach a hostname that does not
resolve from its own network — start the Caddy container above (and the dev API,
not the Swarm-stack API) before retrying.

### Production / Swarm deployment

Production runs as a **Swarm stack** (`docker stack deploy`). The stack **must**
contain a Caddy service the API can reach by DNS, otherwise every domain or
gateway operation fails with `getaddrinfo EAI_AGAIN caddy`.

Required wiring (mirrors `docker-compose.prod.yml`):

1. **Caddy service in the stack**, on the same overlay networks as the API
   (the `default` stack network plus the `boz_system` overlay created by
   `install.sh`), publishing `80` and `443`, mounting `./Caddyfile` and the
   `caddy_data` / `caddy_config` volumes. Its `deploy` block must set a restart
   policy (the API will boot-fail DNS lookups while Caddy is down).
2. **API environment**: set `CADDY_ADMIN_URL` to the Caddy admin endpoint that
   resolves from the API container. The API **always prefers this env over the
   persisted cluster value** (`getSystemAdminUrl` in
   `packages/api/src/lib/caddy-admin.ts`) — the DB row is only a fallback.
   Typical values: `http://caddy:2019` (Caddy declared in the stack compose
   file, see `docker-compose.prod.yml`), or `http://<stack>_caddy:2019` when
   the Caddy service is created ad-hoc with `docker service create`.
3. **DNS naming (Swarm gotcha)**: services declared **in the stack compose
   file** resolve by BOTH their compose name (`caddy`, `api`, `web`) and their
   swarm name (`<stack>_caddy`…). Services added ad-hoc via `docker service
   create` resolve **only** by their swarm name. The repo `Caddyfile` dials
   `api:4000` / `web:80`, which works as long as Caddy is part of the stack; a
   Caddy added ad-hoc must target the swarm names (`hullbaytest_api`, …). Keep
   `admin 0.0.0.0:2019` in the global block — the admin API is reachable from
   the API container and never mapped to the host.

```caddyfile
# Caddy déclaré dans le fichier stack (noms compose résolvables)
{
    admin 0.0.0.0:2019
}
:80 {
    handle /api/* { reverse_proxy api:4000 }
    handle /ws*   { reverse_proxy api:4000 }
    handle        { reverse_proxy web:80 }
}
```

Verification after deploying the stack:

```bash
# from the API container: "caddy" must resolve to an IP (not RESOLVE_FAIL)
docker exec <api-container> getent hosts caddy

# the admin config API must answer from the API container
docker exec <api-container> sh -c 'wget -qO- http://caddy:2019/config/apps/http/servers || true'
```

## Monorepo structure

The packages/shared package is the single source of truth for shared types and validation rules. Changes affecting the shape of projects, nodes, edges, or connection rules should be made there first and then propagated to the API and web layers.

```text
packages/
├── shared
├── api
└── web
```

## Git workflow

Use short, descriptive branch names such as feature/..., fix/..., or chore/... and keep changes focused on a single concern.

## Required checks before pushing

Run the following commands before submitting changes:

```bash
npm run typecheck
npm run build --workspace @hullbay/api
npm run build --workspace @hullbay/web
npm run i18n:validate --workspace @hullbay/web
```

### Internationalization (i18n)

hullbay supports French and English through **react-i18next**. All user-facing text must be translated.

#### File structure

```text
packages/web/src/i18n/
├── config.ts              # i18next configuration with language detection
└── locales/
    ├── en.json            # English translations
    └── fr.json            # French translations (must match en.json keys)
```

#### Adding new translations

1. **Add keys to both `en.json` and `fr.json`** in the same hierarchical position
2. **Use the `useTranslation` hook** in components:
   ```typescript
   import { useTranslation } from 'react-i18next'
   
   function MyComponent() {
     const { t } = useTranslation()
     return <Button>{t('mySection.myKey')}</Button>
   }
   ```
3. **Validate synchronization** before committing:
   ```bash
   npm run i18n:validate --workspace @hullbay/web
   ```

#### Key naming conventions

- Use **dot notation** for nested keys: `section.subsection.key`
- Group by **feature or page**: `auth.login.emailLabel`, `projects.toast.createSuccess`
- Use **camelCase** for key names: `emailLabel`, not `email_label`
- For interpolation, use double braces: `"{{count}} items"`

#### Language detection

The app automatically detects the browser language on first visit, then persists the user's choice in `localStorage` under the key `user-language`. Users can change the language in Settings.

#### Common pitfalls

- Hardcoded strings in JSX: `<Text>Projects</Text>`
- Translated: `<Text>{t('nav.projects')}</Text>`
- Mismatched keys between en.json and fr.json
- Run `npm run i18n:validate` to catch synchronization issues

### API tests and coverage

```bash
cd packages/api
npm test                          # suite complète (vitest)
npm run test:coverage             # couverture sur src/modules
```

The system-update module (`src/modules/updates`) must keep **coverage above
80%** (statements/lines). New branches in `updater.ts`, `github.ts` or the
routes must come with unit tests.

#### Mocking conventions (Prisma)

Prisma accessors have a precise semantic. Respect it in the source code and
mirror it exactly in the tests:

- `findUnique` / `findFirst` — absence is a **legitimate case**; they return
  `null` and the code must handle it (lookups, optional reads).
- `findUniqueOrThrow` / `findFirstOrThrow` — absence is an **error**; they
  throw and the code relies on it (guards, authorization lookups).

Rules for unit tests that mock `lib/prisma`:

- A mock must expose **exactly** the accessor the code under test calls.
  No dead mocks (methods the exercised path never reaches), no missing mocks
  (methods the exercised path calls but the mock omits).
- When a module is mocked entirely (service, client), mock methods inside it
  are not needed at the Prisma level.
- When a guard relies on `findUniqueOrThrow`, the mock exposes it and a test
  asserts the error branch (e.g. `409`).

### Web E2E (Playwright)

The updates UI is covered by end-to-end specs that **stub the API** via
`page.route` — no Postgres, Redis or Docker is required to run them:

```bash
cd packages/web
npm run e2e:install                # one-time Chromium download
npm run e2e
```

New UI flows on the updates page should be mirrored in
`packages/web/e2e/updates.spec.ts`.

### Documentation

The updates system is documented in `docs/`:

- `updates-guide-utilisateur.md` — user-facing workflow (update, rollback, channels)
- `updates-guide-developpeur.md` — architecture, API, sensitive points
- `updates-troubleshooting.md` — common failures and fixes

Update these guides when changing user-visible behavior or the pipeline.

## Architecture

Voir [docs/architecture.md](./docs/architecture.md) pour les conventions
(emplacement des subscribers, etc.) avant d'ajouter un nouveau module.

## Pull requests

Before opening a pull request, ensure that:

- the change is linked to an issue when appropriate
- the relevant type changes pass through packages/shared
- typechecking and builds succeed locally
- the PR description clearly explains the motivation and impact

## Security

For security vulnerabilities, do not open a public issue. Please follow the responsible disclosure process described in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions may be distributed under the MIT License.