# Dashboard Consumer

Consumes `hazard-events` as consumer group `dashboard-consumer-group` by default. Its offset is committed only after the dashboard handler succeeds, giving at-least-once delivery; the eventual dashboard projection must therefore be idempotent.

Copy `.env.example` to `.env`. Run `docker compose up` in this directory for an isolated development stack.
