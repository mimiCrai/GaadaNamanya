CREATE TYPE "public"."threat_level" AS ENUM('Waspada', 'Siaga', 'Awas');--> statement-breakpoint
CREATE TABLE "seismic_events" (
	"event_id" varchar(64) PRIMARY KEY NOT NULL,
	"magnitude" double precision NOT NULL,
	"depth_km" double precision NOT NULL,
	"epicenter_lat" double precision NOT NULL,
	"epicenter_lon" double precision NOT NULL,
	"region_name" varchar(255) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"potential_tsunami" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tsunami_warnings" (
	"warning_id" varchar(64) PRIMARY KEY NOT NULL,
	"related_event_id" varchar(64) NOT NULL,
	"threat_level" "threat_level" NOT NULL,
	"affected_zones" text[] NOT NULL,
	"estimated_arrival" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tsunami_warnings" ADD CONSTRAINT "tsunami_warnings_related_event_id_seismic_events_event_id_fk" FOREIGN KEY ("related_event_id") REFERENCES "public"."seismic_events"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seismic_events_occurred_at_idx" ON "seismic_events" USING btree ("occurred_at","event_id");--> statement-breakpoint
CREATE INDEX "tsunami_warnings_issued_at_idx" ON "tsunami_warnings" USING btree ("issued_at","warning_id");