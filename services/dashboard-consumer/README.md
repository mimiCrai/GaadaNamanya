# Dashboard Consumer

Consumes the Kafka `hazard-events` topic as `dashboard-consumer-group` and maintains a dashboard-owned projection. It never reads the BNPB Aggregator's Canonical Store.

- `GET /dashboard` — auto-refreshing HTML dashboard.
- `GET /api/hazards` — JSON projection.
- `GET /health` — health endpoint.

The service stores one current row per `hazardId` in its own database and deduplicates Kafka redelivery using `processed_events`.

For the full architecture, configuration, and demo instructions, see [consumer implementation notes](../../docs/consumer-implementation.md). Run the full stack from the repository root with `docker compose up`.
