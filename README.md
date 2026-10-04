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

The Aggregator polls the source services in the background, normalises source records into `HazardEvent` records, writes them to the Canonical Store, and publishes newly ingested events. The Client API validates JWTs and applies scope-based field filtering before returning canonical hazard data.

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

## Local Kafka

Start the current BNPB event stack (Canonical PostgreSQL, Kafka, Aggregator, and both consumers):

```bash
docker compose up --build
```

Services run directly on the host use `KAFKA_BROKERS=localhost:9092`. Services inside root Compose use `KAFKA_BROKERS=kafka:29092`.

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
