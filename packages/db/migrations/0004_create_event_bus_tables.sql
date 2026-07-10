CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consumer_name" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_event_id_uq" ON "event_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_outbox_unpublished_idx" ON "event_outbox" USING btree ("created_at") WHERE "event_outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "processed_event_consumer_event_uq" ON "processed_event" USING btree ("consumer_name","event_id");