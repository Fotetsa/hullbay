# Contributing to Bozando Ops

Thank you for considering a contribution to Bozando Ops. This guide outlines the development setup, contribution flow, and quality checks expected for changes to the project.

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
| DATABASE_URL | postgresql://ops:...@localhost/bozando_ops |
| DOCKER_HOST | leave empty to use the Unix socket by default |

The DOCKER_SOCKET_PATH variable is only needed for non-standard socket paths.

### Install dependencies and prepare the database

```bash
npm install
npm run prisma:generate --workspace @bozando-ops/api
npm run prisma:migrate --workspace @bozando-ops/api
```

Do not edit Prisma migration files manually. Use Prisma migration commands for schema changes.

### Start the development servers

Run the following in two separate terminals from the repository root:

```bash
npm run predev --workspace @bozando-ops/shared
npm run dev --workspace @bozando-ops/api
npm run dev --workspace @bozando-ops/web
```

The web app runs on port 5273 and calls the API on port 4000. The first launch of the UI should guide you through the bootstrap flow to create the initial owner account.

### Verify the development gateway

Gateway nodes use the Caddy admin API on port 2019. For local development, ensure that the endpoint is reachable:

```bash
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

The expected result is 200.

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
npm run build --workspace @bozando-ops/api
npm run build --workspace @bozando-ops/web
```

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