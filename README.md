# Bozando Ops

<div align="center">
  <img src="docs/image%20canvas.png" alt="Bozando Ops interface" width="1100" />
  <p><strong>Visual infrastructure operations for Docker and Swarm</strong></p>
  <p>Design, review, and deploy container-based environments from a GNS3-style canvas with a clear and auditable workflow.</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
    <a href="README.md"><img src="https://img.shields.io/badge/status-production-success.svg" alt="Project status" /></a>
  </p>
</div>

## Overview

Bozando Ops is a visual operations plane for modern infrastructure teams. It transforms Docker-based deployments into a safe, guided experience where services, networks, volumes, and routing can be drawn, reviewed, and applied from a single interface.

The platform is designed for a single VPS or a Swarm cluster and aims to make infrastructure operations accessible, traceable, and less error-prone for both operators and teams with limited Docker experience.

## Key capabilities

- Visual topology design for containers, networks, gateways, and volumes
- Deployment review with a clear before/after plan before applying changes
- Multi-node Docker Swarm orchestration with resilient rollout behavior
- Provisioning and server onboarding workflows with secure SSH handling
- Observability, health monitoring, and drift detection
- Secrets management and role-based access control for delegated operations

## Screenshots

### Health and observability

<div align="center">
  <img src="docs/image%20sant%C3%A9.png" alt="Bozando Ops health view" width="1000" />
</div>

## Architecture

The project is organized as a monorepo with three main packages:

| Package | Role |
|---|---|
| packages/shared | Shared domain model and validation contracts for projects, nodes, and edges |
| packages/api | Backend service for orchestration, Docker integration, sockets, Prisma, and RBAC |
| packages/web | React and Vite front end with a visual canvas and operator workflow UI |

A core principle of the platform is that Docker labels act as a redundant source of truth. The canvas can be reconstructed from the runtime state, while the database serves as a convenient operational cache.

## Quick start

On a fresh server, the installation flow is handled by the provided script:

```bash
curl -fsSL https://raw.githubusercontent.com/bright77777/bozando-ops/master/install.sh | bash
```

The installer is idempotent and will:

1. Install Docker and initialize Swarm if needed
2. Generate the required environment and secret files
3. Pull the production stack configuration
4. Start the operations panel

Available environment variables include GHCR_OWNER, IMAGE_TAG, and PUBLIC_HOST. Once the service is up, open the displayed URL and complete the bootstrap flow to create the initial owner account.

## Usage

- Roles and permissions are handled through RBAC, with owner, operator, and viewer levels
- Deployment is performed from the canvas after reviewing the proposed changes
- Audit history helps track who created, modified, or removed resources and when

## Security

Security measures include encrypted secrets, restricted Docker socket access, MFA support, and log redaction. For more detail, see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. For local development setup, conventions, and pull request guidance, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE) for details.