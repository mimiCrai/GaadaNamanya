# Notification Consumer

Consumes `hazard-events` as consumer group `notification-consumer-group` by default. Its offset is committed only after the notification handler succeeds, giving at-least-once delivery; the eventual notification delivery operation must therefore be idempotent.

Copy `.env.example` to `.env`. Run `docker compose up` in this directory for an isolated development stack.
