# GaadaNamanya

Proof of concept for the IF4031 distributed disaster-coordination platform. It simulates BMKG and PVMBG as autonomous data providers, while BNPB ingests their data, converts it to a common hazard format, and distributes it to authorised clients and event consumers.

This repository is currently scaffolded: every application service begins from the shared Express/TypeScript template. Service-specific endpoints, schemas, and orchestration will be added incrementally.

## Architecture

```text
BMKG Mock ─┐
           ├──> BNPB Aggregator ───> Canonical Store (PostgreSQL + JSONB)
PVMBG Mock ┘             │
                         ├──> RabbitMQ exchange ──> dashboard queue ──> Dashboard Consumer
                         │                       └> notification queue -> Notification Consumer
                         │
Downstream client ─> BNPB Client API ─> Aggregator internal API
       │                     ↑
       └──> BNPB Auth Service (token / refresh only)
```

The BNPB Aggregator polls the source services in the background, normalises source records into `HazardEvent` records, writes them to the Canonical Store, and publishes newly ingested events.

Downstream clients obtain an access token from the Auth Service, then call the Client API with that token. The Client API verifies the JWT and applies scope-based field filtering before returning canonical hazard data.

## Services

| Service | Directory | Responsibility |
| --- | --- | --- |
| BMKG Mock | `services/bmkg` | Simulates seismic events and tsunami warnings. It owns BMKG source data and validates the `X-BMKG-Key` credential. |
| PVMBG Mock | `services/pvmbg` | Simulates volcanic reports, configurable slowness/outages, and additive schema evolution. It owns PVMBG source data and validates its bearer token. |
| BNPB Aggregator | `services/bnpb-aggregator` | Runs polling loops, maps source payloads to `HazardEvent`, correlates tsunami warnings with seismic events, owns the Canonical Store, and publishes hazard events. |
| BNPB Client API | `services/bnpb-client-api` | Public API for Media, Field Team, and BNPB Internal clients. It validates JWTs, enforces scopes, and reads canonical data through the Aggregator API. |
| BNPB Auth | `services/bnpb-auth` | Authenticates separate downstream client identities and issues short-lived JWT access tokens plus rotating refresh tokens. |
| Dashboard Consumer | `services/dashboard-consumer` | Independently subscribes to hazard events and represents a live BNPB dashboard update. |
| Notification Consumer | `services/notification-consumer` | Independently subscribes to the same hazard events and represents field-alert delivery. |

## Infrastructure

The following are supporting components rather than application services:

| Component | Purpose | Ownership |
| --- | --- | --- |
| Canonical Store | PostgreSQL database using JSONB for dynamic source-specific attributes. | BNPB Aggregator only |
| Auth Store | Stores client credentials and refresh-token/session state. | BNPB Auth only |
| RabbitMQ | Delivers newly ingested `HazardEvent` messages to independent consumers. | Shared broker infrastructure |

RabbitMQ supports the required pub/sub fan-out pattern. The Aggregator publishes each event once to an exchange (for example, `hazard.events`). The Dashboard Consumer and Notification Consumer each bind their own queue to that exchange, so both receive a copy of every event.

```text
Aggregator publishes one event
           ↓
RabbitMQ exchange
    ├──> dashboard-events queue ───> Dashboard Consumer
    └──> notification-events queue -> Notification Consumer
```

In contrast, multiple consumers attached to the *same* queue compete for messages, so each message goes to only one of them. We will use separate queues to meet the Milestone 1 fan-out requirement.

## Repository layout

```text
docs/                     Laporan
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

Each service is independently containerised and exposes a health-check endpoint. A root-level Docker Compose file will orchestrate the complete platform.

## Security configuration

Secrets and environment-specific values must never be committed. Each service has an `.env.example` template. For JWTs, the Auth Service holds the private signing key, while the Client API receives only the public verification key.
