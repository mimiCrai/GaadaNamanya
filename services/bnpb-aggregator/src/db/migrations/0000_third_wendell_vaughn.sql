CREATE TYPE "public"."hazard_severity" AS ENUM('NORMAL', 'WASPADA', 'SIAGA', 'AWAS');--> statement-breakpoint
CREATE TYPE "public"."hazard_source" AS ENUM('BMKG', 'PVMBG');--> statement-breakpoint
CREATE TYPE "public"."hazard_type" AS ENUM('SEISMIC', 'VOLCANIC');--> statement-breakpoint
CREATE TYPE "public"."source_stream" AS ENUM('BMKG_SEISMIC', 'BMKG_TSUNAMI_WARNING', 'PVMBG_VOLCANIC');--> statement-breakpoint
CREATE TYPE "public"."source_sync_status" AS ENUM('HEALTHY', 'STALE', 'UNAVAILABLE');--> statement-breakpoint
CREATE TABLE "hazard_events" (
	"hazard_id" varchar(128) PRIMARY KEY NOT NULL,
	"source" "hazard_source" NOT NULL,
	"source_ref_id" varchar(255) NOT NULL,
	"hazard_type" "hazard_type" NOT NULL,
	"severity" "hazard_severity" NOT NULL,
	"area_name" varchar(255) NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"outbox_event_id" varchar(36) PRIMARY KEY NOT NULL,
	"aggregate_id" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"topic" varchar(255) NOT NULL,
	"partition_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(1000)
);
--> statement-breakpoint
CREATE TABLE "pending_tsunami_warnings" (
	"warning_id" varchar(255) PRIMARY KEY NOT NULL,
	"related_event_id" varchar(255) NOT NULL,
	"warning" jsonb NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_sync_states" (
	"source_stream" "source_stream" PRIMARY KEY NOT NULL,
	"status" "source_sync_status" DEFAULT 'UNAVAILABLE' NOT NULL,
	"last_successful_poll_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"stale_since" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hazard_events_source_ref_id_unique" ON "hazard_events" USING btree ("source","source_ref_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_created_at_index" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
INSERT INTO "source_sync_states" ("source_stream") VALUES
	('BMKG_SEISMIC'),
	('BMKG_TSUNAMI_WARNING'),
	('PVMBG_VOLCANIC');
