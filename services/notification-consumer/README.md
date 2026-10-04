# Notification Consumer

Consumes the Kafka `hazard-events` topic as `notification-consumer-group` and maintains a notification-owned inbox. It never reads the BNPB Aggregator's Canonical Store.

- `GET /notifications` — auto-refreshing HTML inbox.
- `GET /api/notifications` — JSON inbox entries.
- `GET /health` — health endpoint.

The M1 policy creates inbox entries for `SIAGA` and `AWAS` events. Kafka redelivery is deduplicated using this service's `processed_events` table.

For the full architecture, configuration, and demo instructions, see [consumer implementation notes](../../docs/consumer-implementation.md). Run the full stack from the repository root with `docker compose up`.
