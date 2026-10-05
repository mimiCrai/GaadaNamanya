# BNPB Aggregator

Owns the Canonical Store, polls source services, normalises source records into `HazardEvent`s, and publishes those events to Kafka.

## Kafka contract

| Setting | Value |
| --- | --- |
| Topic | `hazard-events` by default (`KAFKA_TOPIC`) |
| Producer acknowledgement | Kafka leader and in-sync replicas (`acks=-1`) |
| Message key | Optional; use the canonical hazard ID when publishing hazard events |

`MessagePublisher` is the Kafka adapter. The future transactional-outbox relay should call it only after it reads a committed outbox row.

Copy `.env.example` to `.env`. Run `docker compose up` in this directory for an isolated Aggregator, PostgreSQL, and Kafka development stack.
