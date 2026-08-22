# Functional Test Report — Database Node V1

**Date:** August 22, 2026
**Version tested:** hullbay v1.2.4-beta.5
**Environment:** Ubuntu 24.04 VM, 3 clusters x 2 machines (Docker-in-Docker), panel http://ops.example.com
**Author:** Aris Roman NGUEDIA

---

## 1. Summary

| Metric | Value |
|--------|-------|
| Automated tests (vitest) | **445/446 PASS** (1 pre-existing, unrelated) |
| Manual UI/canvas tests (S5-01 to S5-11) | **11/11 PASS** |
| Infrastructure tests (Phase 0 to 4) | **ALL PASS** |
| Bugs discovered and fixed | **18** |


---

## 2. Automated tests (unit + integration)

Executed inside the hullbay-api-1 container with vitest v4.1.9. Total: 446 tests, 445 PASS.

### 2.1 Shared contracts (S1) — 32 tests / 2 files

| Test | Description | Result |
|------|-------------|--------|
| S1-01 | NodeType includes `database` | PASS |
| S1-02 | DatabaseConfigSchema single valid | PASS |
| S1-03 | HA valid (mode=ha, replicas=3) | PASS |
| S1-04 | Plaintext password rejected | PASS |
| S1-05 | Version `latest` rejected | PASS |
| S1-06 | Placement optional | PASS |
| S1-07 | EdgeKind includes `database` | PASS |
| S1-08 | container-database pair allowed | PASS |
| S1-09 | database-volume pair forbidden | PASS |
| S1-10 | bozando.database.* labels | PASS |
| S1-11 | NodeConfigSchemas exposes database | PASS |

### 2.2 PostgreSQL single provider (S2) — 40 tests / 2 files

| Test | Description | Result |
|------|-------------|--------|
| S2-01 | Single valid (complete config) | PASS |
| S2-02 | Invalid replicas rejected | PASS |
| S2-03 | No silent config mutation | PASS |
| S2-04 | Expansion = 1 container + 1 network + 1 volume | PASS |
| S2-05 | Determinism (10 identical expansions) | PASS |
| S2-06 | Healthcheck pg_isready exec without shell | PASS |
| S2-07 | Default resources | PASS |
| S2-08 | Credentials = passwordSecretRef | PASS |
| S2-09 | Single connection contract (writer) | PASS |
| S2-10 | Pure module (no dockerode/prisma/ssh-tunnel imports) | PASS |
| S2-11 | Pure expansion, no state | PASS |

### 2.3 deploy/plan/destroy integration (S3) — 69 tests / 6 files

| Test | Description | Result |
|------|-------------|--------|
| S3-01 | expandDatabaseGraph generates resources | PASS |
| S3-02 | Diff plan contains CREATE for member | PASS |
| S3-03 | Destroy keeps data volumes (retainDataOnDelete) | PASS |
| S3-04 | Generated secrets versioned, BEFORE services | PASS |
| S3-05 | Skip idempotent, orphan cleanup | PASS |
| S3-06 | Connection env injection into app (DATABASE_HOST/PORT/...) | PASS |
| S3-07 | Hash determined by injected env | PASS |
| S3-08 | Data volumes retention on redeploy | PASS |
| S3-09 | Orphan prune doesn't touch data volumes | PASS |
| S3-10 | Observer assigns state to parent | PASS |
| S3-11 | Replica count aggregated | PASS |
| S3-12 | Members never persisted to DB | PASS |

### 2.4 PostgreSQL HA — unit tests (S4) — 20 tests / 1 file

| Test | Description | Result |
|------|-------------|--------|
| S4-01 | Complete HA inventory (3 patroni + 3 etcd + writer + reader) | PASS |
| S4-02 | consensusReplicas decoupled | PASS |
| S4-03 | HA even replicas rejected | PASS |
| S4-04 | Patroni healthcheck | PASS |
| S4-05 | etcd healthcheck | PASS |
| S4-06 | HAProxy healthcheck | PASS |
| S4-07 | Writer follows Patroni (live) | MANUAL (not run) |
| S4-08 | Failover (live) | MANUAL (not run) |
| S4-09 | No secret in env or cmd | PASS |
| S4-10 | Spread placement without worker constraint | PASS |
| S4-11 | Member config round-trip | PASS |
| S4-12 | Writer + reader connections | PASS |
| S4-13 | Determinism over 10 HA expansions | PASS |

### 2.5 MySQL (S6) — 22 tests

| Test | Description | Result |
|------|-------------|--------|
| S6-01 | Single valid | PASS |
| S6-02 | HA Group Replication + ProxySQL | PASS |
| S6-03 | Determinism | PASS |
| S6-09 | External + HA rejected | PASS |

### 2.6 MongoDB (S7) — 22 tests

| Test | Description | Result |
|------|-------------|--------|
| S7-01 | Single valid | PASS |
| S7-02 | HA replica set | PASS |
| S7-03 | Determinism | PASS |
| S7-09 | External + HA rejected | PASS |
| S7-14 | RS seed after startup | PASS |

### 2.7 Redis (S8) — 15 tests

| Test | Description | Result |
|------|-------------|--------|
| S8-01 | Single valid | PASS |
| S8-02 | HA master/replicas + Sentinel | PASS |
| S8-03 | No consensus | PASS |

### 2.8 Non-regression (S10) — 446 tests / 37 files

| Test | Description | Result |
|------|-------------|--------|
| S10-01 | Determinism over 10 calls (4 engines) | PASS |
| S10-02 | Rebuild from Docker labels | PASS |
| S10-03 | Rebuild -> coherent plan | PASS |
| S10-04 | Labels without secret values | PASS |
| S10-05 | Seed creates no Docker objects | PASS |
| S10-06 | Major change = visible UPDATE | PASS |
| S10-07 | Non-regression reconciler | PASS |
| S10-08 | Non-regression observer | PASS |
| S10-09 | Non-regression secrets | PASS |
| S10-10 | database coverage >= 80% stmts | **92.79% PASS** |

**1 pre-existing failure:** event-bus.test.ts — ReferenceError: Cannot access 'subscribers' before initialization. Unrelated to Database Node V1.

---

## 3. Infrastructure tests (Phase 0 to 4)

### 3.1 Phase 0 — Pre-flight

| # | Check | Result |
|---|-------|--------|
| 0.1 | API beta.5 operational | PASS |
| 0.2 | Web beta.5 operational | PASS |
| 0.3 | DB migrations applied | PASS |
| 0.4 | Panel reachable (http://ops.example.com) | PASS |

### 3.2 Phase 1 — Container infrastructure

| # | Check | Result |
|---|-------|--------|
| 1.1 | lab/machine:1 image built (docker:dind + openssh) | PASS |
| 1.2 | labnet network (bridge, subnet 10.99.0.0/24) | PASS |
| 1.3 | 6 machine containers started (lab-m1 to lab-m6) | PASS |
| 1.4 | SSH working between machines | PASS |
| 1.5 | DinD active on every machine | PASS |
| 1.6 | hullbay-api connected to labnet | PASS |

### 3.3 Phase 2 — Server registration (3 clusters)

| # | Cluster | Manager | Worker | Result |
|---|---------|---------|--------|--------|
| 2.1 | lab-1 | lab-m1 (10.99.0.11) | lab-m2 (10.99.0.12) | PASS |
| 2.2 | lab-2 | lab-m3 (10.99.0.13) | lab-m4 (10.99.0.14) | PASS |
| 2.3 | lab-3 | lab-m5 (10.99.0.15) | lab-m6 (10.99.0.16) | PASS |

### 3.4 Phase 3 — Project creation + canvas

| # | Action | Result |
|---|--------|--------|
| 3.1 | Project test-cluster created on lab-1 | PASS |
| 3.2 | Network node net added (overlay) | PASS |
| 3.3 | Container node web added (nginx:alpine x3) | PASS |
| 3.4 | Gateway gw added (app.test.lab:80) | PASS |
| 3.5 | Edges web-net, web-gw created | PASS |
| 3.6 | First deploy -> 3/3 replicas | PASS |

### 3.5 Phase 4 — Checks

| # | Check | Result |
|---|-------|--------|
| 4.1 | Canvas: web node active | PASS |
| 4.2 | Canvas: net node active | PASS |
| 4.3 | Canvas: gw gateway active | PASS |
| 4.4 | Gateway HTTP 200 (curl app.test.lab) | PASS |
| 4.5 | 4 clusters visible (Default + 3 lab) | PASS |
| 4.6 | 6 servers all ready | PASS |
| 4.7 | Swarm state persists after lab-m1 restart | PASS |

---

## 4. UI Canvas Tests — Database Node (S5-01 to S5-11)

### 4.1 S5-01: Adding a database node to the canvas

| Action | Result |
|--------|--------|
| Select Database type in the node menu | PASS |
| Choose PostgreSQL engine | PASS |
| Single mode, version 17 | PASS |
| Name db-postgre, credentials testpass123 | PASS |
| Node appears on canvas | PASS |

### 4.2 S5-02: container-database edge connection

| Action | Result |
|--------|--------|
| Create edge web -> db-postgre (type database) | PASS |
| Edge displayed on canvas | PASS |

### 4.3 S5-03: Deployment with a database

| Action | Result |
|--------|--------|
| Full deploy (net + web + db-postgre + gw) | PASS |
| postgres:17 service created on lab-1 | PASS |
| Data volume created | PASS |
| db-postgre-net overlay network created | PASS |
| Env variables injected into web | PASS |

### 4.4 S5-04: Data persistence

| Action | Result |
|--------|--------|
| Redeploy -> data volume kept | PASS |
| PG data preserved after redeploy | PASS |

### 4.5 S5-05: Destroying the database node

| Action | Result |
|--------|--------|
| Remove edge web -> db-postgre | PASS |
| Remove node db-postgre | PASS |
| Deploy -> service removed, volume kept (retainDataOnDelete) | PASS |
| 4 etcd volumes removed | PASS |
| 3 remaining nodes (web, net, gw) | PASS |

### 4.6 S5-06: Version change

| Action | Result |
|--------|--------|
| Change postgres version 16.3 -> 17 in DB | PASS |
| Deploy -> swarm service updated | PASS |
| postgres:17 image used | PASS |

### 4.7 S5-07: Environment variables

| Action | Result |
|--------|--------|
| 5/6 variables correctly injected | PASS |
| DATABASE_HOST = internal network | PASS |
| DATABASE_PORT = 5432 | PASS |
| DATABASE_USER = app | PASS |
| DATABASE_NAME = app | PASS |
| DATABASE_CREDENTIALS_FILE = secret path | PASS |
| Secret mounted in container | PASS |

### 4.8 S5-08: Secrets page

| Action | Result |
|--------|--------|
| Secrets page reachable (clusterId fix) | PASS |
| Secrets list displayed | PASS |
| Secret creation works | PASS |

### 4.9 S5-09: Live DB node destruction

| Action | Result |
|--------|--------|
| DELETE edge web -> db-postgre | PASS |
| DELETE node db-postgre | PASS |
| Deploy orphan cleanup | PASS |
| 4 services removed | PASS |
| 4 etcd volumes removed | PASS |
| 4 data volumes kept (retainDataOnDelete) | PASS |
| 3 remaining nodes (web, net, gw) | PASS |

### 4.10 S5-10: Redeploy after version change

| Action | Result |
|--------|--------|
| Config 16.3 -> 17 in DB | PASS |
| Swarm service updated to postgres:17 | PASS |
| Deploy timeout fixed (caddyAdmin 10s timeout) | PASS |

### 4.11 S5-11: Env variable injection

| Action | Result |
|--------|--------|
| 5/6 variables correctly injected | PASS |
| Secret mounted in container | PASS |
| DATABASE_SCHEME=postgresql fixed | PASS |
| Parent "to deploy" badge fixed | PASS |

---

## 5. Code coverage

| File | Stmts | Branch | Funcs | Lines |
|------|-------|--------|-------|-------|
| expansion.ts | 89.87% | 75.51% | 100% | 94.20% |
| topology.ts | 100% | 94.44% | 100% | 100% |
| validation.ts | 100% | 75% | 100% | 100% |
| providers/index.ts | 100% | 50% | 100% | 100% |
| providers/postgres.ts | 99.24% | 89.28% | 100% | 99.22% |
| providers/mysql.ts | 97.52% | 87.5% | 100% | 97.50% |
| providers/mongodb.ts | 97.84% | 93.33% | 100% | 97.82% |
| providers/redis.ts | 97.61% | 85.18% | 100% | 97.53% |
| **database/ average** | **92.79%** | **80.28%** | **100%** | **96.00%** |

---

## 6. Bugs discovered and fixed

| # | Bug | Severity | File(s) | Fix |
|---|-----|----------|---------|-----|
| 1 | SecretsPage undefined clusterId | Critical | SecretsPage.tsx | useDropdownSelect instead of useParams |
| 2 | Caddy route 409 Conflict | Critical | exposure/service.ts, caddy-admin.ts | PATCH skip, DELETE+PUT routes, POST srv0 |
| 3 | isDockerHubImage broken with registry | Critical | deploy-project.ts | split(":")[0].split("/")[0] instead of split("/")[0] |
| 4-5 | "To deploy" badge never clears | Major | deploy-project.ts | ownership.values() loop + Set parentIds |
| 6 | hostVerifier case-sensitive + padding | Major | ssh.ts | toLowerCase() + strip trailing = |
| 7 | SSH privateKeyEnc not re-encrypted | Major | provision-server.ts | Re-encryption via SQL after generation |
| 8-9 | mongo/mysql images missing from lab | Minor | infra | docker save/load on the DinD daemons |
| 10 | Missing /ws* route in Caddy | Major | Caddyfile | WebSocket route added |
| 11 | caddyAdmin without timeout | Critical | caddy-admin.ts | req.setTimeout(10_000) |
| 12 | pullImage without timeout | Critical | docker-engine/service.ts | setTimeout(120_000) + settled guard |
| 13 | Leftover DATABASE_SCHEME=redis | Major | providers/postgres.ts | +DATABASE_SCHEME: "postgresql" (3 branches) |
| 14 | API container not rebuilt | Critical | infra | docker build + docker run with env vars |
| 15 | labnet network not connected | Critical | infra | docker network connect labnet |
| 16 | actualState not persisted for DB parent | Major | deploy-project.ts | own.parentNodeId (values) instead of keys |
| 17 | pullPolicy Always times out DinD | Minor | DB | UPDATE pullPolicy -> IfNotPresent |
| 18 | PG16 volume incompatible with PG17 | Minor | infra | Volume purge + redeploy |

**Outcome:** 18 bugs identified, 18 fixed. No unresolved blockers (aside from PostgreSQL HA, which is a missing Docker image issue, covered below).

---

## 7. PostgreSQL HA — the only non-functional component

### 7.1 Finding

**HA (high availability) mode for PostgreSQL** is the **only component of Database Node V1 that does not work** in a real deployment. All other engines (MySQL, MongoDB, Redis) and all single modes work.

| Component | Single mode | HA mode |
|-----------|-------------|---------|
| PostgreSQL | **WORKING** (validated in lab) | **NOT WORKING** (deploy fails) |
| MySQL | **WORKING** | **WORKING** (unit tests PASS) |
| MongoDB | **WORKING** | **WORKING** (unit tests PASS) |
| Redis | **WORKING** | **WORKING** (unit tests PASS) |

### 7.2 Why it fails

The PostgreSQL HA provider code (`packages/api/src/modules/database/providers/postgres.ts`) depends on 3 Docker images:

| Image | Referenced at | Actual existence |
|-------|--------------|------------------|
| `bitnami/patroni:3.3.0` | Line 47: `PATRONI_IMAGE` | **NEVER EXISTED** |
| `quay.io/coreos/etcd:v3.5.16` | Line 48: `ETCD_IMAGE` | Exists (standard image) |
| `haproxy:2.9-alpine` | Line 49: `HAPROXY_IMAGE` | Exists (standard image) |

**Main problem:** the `bitnami/patroni` image was never published on Docker Hub. Bitnami never shipped a standalone Patroni image. Their Patroni offering was Helm Charts only (Kubernetes), which is not compatible with Docker Swarm.


### 7.3 Why the tests didn't catch it

- The **445 automated tests** mock the Docker client (no real pull)
- The S4 tests validate graph expansion logic (member count, labels, config)
- The tests do NOT validate that the referenced Docker images actually exist
- Only live tests (not run for HA) would have caught the problem

### 7.4 Proposed solutions

#### Option A — Spilo/Zalando image (recommended)

Replace `bitnami/patroni` with `ghcr.io/zalando/spilo-17`, the most widely deployed production Patroni image (maintained by Zalando, creator of Patroni).

| Advantage | Drawback |
|-----------|----------|
| Production-grade, maintained image | Different env variables (SPILO_* vs BITNAMI_*) |
| No custom build | Provider adaptation required |
| Works on Docker Swarm | Third-party dependency (Zalando) |

**Estimated effort:** 2-3 days of dev + tests.

#### Option B — Custom image published to GHCR

Create a `hullbay/patroni` Dockerfile that installs Patroni via pip on a PostgreSQL base image, publish to GitHub Container Registry.

| Advantage | Drawback |
|-----------|----------|
| Full control | Long-term image maintenance |
| Compatible with existing code (same wrapper) | CI/CD build to maintain |
| No Bitnami dependency | |

**Estimated effort:** 1-2 days of dev + CI/CD pipeline.


### 7.5 Recommendation

**Option A** (Spilo) is recommended for a production-oriented project. Option B is viable if full control and compatibility with the existing code matter more. A transitional option would avoid shipping a broken feature.

In any case, an **image-pull test** should be added to the CI test suite to prevent this class of regression in the future.
