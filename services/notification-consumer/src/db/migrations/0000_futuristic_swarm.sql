CREATE TABLE "notifications" (
	"event_id" varchar(36) PRIMARY KEY NOT NULL,
	"hazard_id" varchar(36) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"area_name" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" varchar(1000) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" varchar(36) PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
