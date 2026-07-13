CREATE TYPE "public"."backfill_mode" AS ENUM('link-only', 'push');--> statement-breakpoint
CREATE TYPE "public"."backfill_status" AS ENUM('pending', 'running', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."delete_propagation" AS ENUM('ignore', 'propagate');--> statement-breakpoint
CREATE TYPE "public"."target_drift_check" AS ENUM('none', 'read-before-write');--> statement-breakpoint
CREATE TABLE "poll_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_rule_id" uuid NOT NULL,
	"entries" jsonb NOT NULL,
	"record_count" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "poll_interval_override" integer;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "poll_operation_ref" text;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "delete_propagation" "delete_propagation";--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "target_drift_check" "target_drift_check";--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "backfill_mode" "backfill_mode";--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "backfill_status" "backfill_status";--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "last_snapshot_ref" uuid;--> statement-breakpoint
ALTER TABLE "poll_snapshot" ADD CONSTRAINT "poll_snapshot_sync_rule_id_sync_rule_id_fk" FOREIGN KEY ("sync_rule_id") REFERENCES "public"."sync_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poll_snapshot_sync_rule_uq" ON "poll_snapshot" USING btree ("sync_rule_id");--> statement-breakpoint
CREATE INDEX "sync_rule_enabled_idx" ON "sync_rule" USING btree ("status") WHERE "sync_rule"."status" = 'enabled';