CREATE TABLE "dashboard_hazards" (
	"hazard_id" varchar(36) PRIMARY KEY NOT NULL,
	"source" varchar(16) NOT NULL,
	"hazard_type" varchar(16) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"area_name" varchar(255) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"last_event_id" varchar(36) NOT NULL,
	"last_event_type" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" varchar(36) PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
