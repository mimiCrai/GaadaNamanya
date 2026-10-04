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
INSERT INTO "source_sync_states" ("source_stream") VALUES
	('BMKG_SEISMIC'),
	('BMKG_TSUNAMI_WARNING'),
	('PVMBG_VOLCANIC');
--> statement-breakpoint
CREATE UNIQUE INDEX "hazard_events_source_ref_id_unique" ON "hazard_events" USING btree ("source","source_ref_id");
