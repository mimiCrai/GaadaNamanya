CREATE TYPE "public"."alert_level" AS ENUM('Normal', 'Waspada', 'Siaga', 'Awas');--> statement-breakpoint
CREATE TABLE "volcanic_reports" (
	"report_id" varchar(64) PRIMARY KEY NOT NULL,
	"volcano_id" varchar(64) NOT NULL,
	"alert_level" "alert_level" NOT NULL,
	"eruption_count_24h" integer NOT NULL,
	"ash_column_height_m" double precision NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"confidence_level" double precision
);
--> statement-breakpoint
CREATE INDEX "volcanic_reports_reported_at_idx" ON "volcanic_reports" USING btree ("reported_at","report_id");--> statement-breakpoint
CREATE INDEX "volcanic_reports_volcano_reported_at_idx" ON "volcanic_reports" USING btree ("volcano_id","reported_at");