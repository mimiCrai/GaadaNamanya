# GaadaNamanya

Proof of concept for the IF4031 distributed disaster-coordination platform. BMKG and PVMBG act as autonomous data providers; BNPB ingests their records, maps them to a common hazard format, and serves authorised clients.

## Architecture

```text
BMKG Mock ──┐
           ├──> BNPB Aggregator ───> Canonical Store (PostgreSQL + JSONB)
PVMBG Mock ─┘             │
                         └──> Kafka topic: hazard-events
                                     ├──> dashboard-consumer-group ───> Dashboard Consumer
                                     └──> notification-consumer-group ─> Notification Consumer

Downstream client ─> BNPB Client API ─> Aggregator internal API
       │
       └───────────────> BNPB Auth Service (token / refresh only)
```

The Aggregator polls the source services in the background, normalises source records into `HazardEvent` records, writes them to the Canonical Store, and publishes newly ingested events. The Client API validates JWTs and applies scope-based field filtering before returning canonical hazard data. It reads from the Aggregator with the separate `X-BNPB-Internal-Key` credential; a client JWT is never accepted as that service-to-service credential.

BMKG and PVMBG are source mocks: each seeds historical data, then evaluates whether to generate one new source record every five seconds. The default `*_GENERATION_PROBABILITY=0.3` means most intervals intentionally produce no new record; set it to `1` for a guaranteed record each interval or `0` to disable live generation.

## Services

| Service | Directory | Responsibility |
| --- | --- | --- |
| BMKG Mock | `services/bmkg` | Simulates seismic events and tsunami warnings; owns BMKG source data. |
| PVMBG Mock | `services/pvmbg` | Simulates volcanic reports, slowness/outages, and additive schema evolution; owns PVMBG source data. |
| BNPB Aggregator | `services/bnpb-aggregator` | Polls, normalises and correlates source data; owns the Canonical Store and publishes hazard events. |
| BNPB Client API | `services/bnpb-client-api` | Public hazard API; validates JWTs, enforces scopes, and reads Canonical data through the Aggregator API. |
| BNPB Auth | `services/bnpb-auth` | Authenticates client identities and issues short-lived JWT access tokens plus rotating refresh tokens. |
| Dashboard Consumer | `services/dashboard-consumer` | Independently consumes `hazard-events` for the BNPB dashboard projection. |
| Notification Consumer | `services/notification-consumer` | Independently consumes `hazard-events` for field-alert delivery. |

## Infrastructure

| Component | Purpose | Ownership |
| --- | --- | --- |
| Canonical Store | PostgreSQL database with JSONB source-specific attributes. | BNPB Aggregator only |
| Auth Store | Stores credentials and refresh-token/session state. | BNPB Auth only |
| Kafka | Durable `hazard-events` stream for downstream consumers. | Shared broker infrastructure |

Kafka has one topic, `hazard-events`. Dashboard and Notification have distinct consumer groups, so each receives every event and can catch up from its committed offset after downtime. Multiple instances in a single group share partitions for horizontal scaling. A future independent consumer only needs its own group; the Aggregator producer does not change.

```text
Aggregator publishes one event
           ↓
Kafka topic: hazard-events
    ├──> dashboard-consumer-group ────> Dashboard Consumer
    └──> notification-consumer-group ─> Notification Consumer
```

## Local configuration

Create a local `.env` from the tracked template:

```powershell
Copy-Item .env.example .env
```

Root Compose resolves its `${...}` variables from that `.env` file. The example values are a complete runnable local configuration, so no edits are needed before starting the current stack. For a deployed environment, replace the sample credentials and host-specific values in the local `.env`. `.env` is ignored by Git; commit only `.env.example`.

## Run the local stack

Start the complete runnable stack: BMKG, PVMBG, their separate PostgreSQL stores, Canonical Store, Kafka, BNPB Aggregator, and both consumers.

```bash
docker compose up --build
```

Each database-owning application runs `npm run db:migrate` after its database becomes healthy and before it starts its server. Compose also creates `hazard-events` before the Aggregator and consumers start, preventing a first-start Kafka topic race. No per-service migration command is needed.

Open the running services at:

- `http://localhost:8081/health` — BMKG mock.
- `http://localhost:8082/health` — PVMBG mock.
- `http://localhost:3000/health` — BNPB Client API.
- `http://localhost:3001/health` — BNPB Auth Service.
- `http://localhost:3003/health` — BNPB Aggregator.
- `http://localhost:3004/dashboard` — Dashboard projection.
- `http://localhost:3005/notifications` — Notification inbox.

Services run directly on the host use `KAFKA_BROKERS=localhost:9092`. Services inside root Compose use `KAFKA_BROKERS=kafka:29092`.

## Authentication and Client API

BNPB Auth (`http://localhost:3001`) owns user credentials and refresh sessions. It signs short-lived RS256 access tokens (60 seconds by default) using its private key; BNPB Client API receives only Auth's public key for verification. Refresh tokens are stored as hashes by Auth, rotate on refresh, and are never sent to Aggregator, BMKG, or PVMBG.

Registering creates a `public` user and immediately returns an access/refresh-token pair:

```bash
curl -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"media@example.com","password":"Password123!"}'
```

Use `POST /auth/login` to obtain a new pair from existing credentials, `POST /auth/refresh` with `{ "refreshToken": "..." }` after the access token expires, and `POST /auth/logout` to revoke a refresh session. Auth also exposes `GET /public-key`, which is used internally by Client API, and administrator-only `/admin/users` endpoints for creating `lapangan` and `internal` identities.

BNPB Client API (`http://localhost:3000`) is the only downstream hazard endpoint. Send the Auth access token with every request:

```bash
curl http://localhost:3000/hazards \
  -H 'Authorization: Bearer <access-token>'
```

`GET /hazards` lists visible hazards, while `GET /hazards/:hazardId` returns one. A `public` user receives the summary representation; `lapangan` and `internal` receive the full representation. Client API forwards the request correlation ID to Auth and Aggregator, and uses its separate `X-BNPB-Internal-Key` only for its internal Aggregator call. It returns `401` for missing, invalid, or expired access tokens and `502` if Auth or Aggregator is unavailable.

## End-to-end checks

Run the isolated E2E suite with one command after creating `.env`:

```bash
bash scripts/test-e2e.sh
```

The script combines the normal Compose file with `docker-compose.e2e.yml`, builds an isolated `bnpb-e2e` project, and removes its test containers and volumes afterward. The override removes host port mappings, so it can run while the normal stack is up. It verifies internal-API authentication, both initial source ingestions, cross-provider credential rejection, PVMBG schema evolution, dashboard and notification projections, and PVMBG error/hang outages without interrupting BMKG ingestion.

## Repository layout

```text
docs/                     Project specification
express-template/         Original shared Express template
services/                 Application services
  bmkg/
  pvmbg/
  bnpb-aggregator/
  bnpb-client-api/
  bnpb-auth/
  dashboard-consumer/
  notification-consumer/
```

Secrets and environment-specific values must not be committed. Each service has an `.env.example` template. Auth holds the JWT private signing key; Client API gets only the public verification key.
