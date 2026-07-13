CREATE TYPE "public"."parked_conflict_kind" AS ENUM('manual-resolve', 'withheld', 'drifted-delete');--> statement-breakpoint
CREATE TYPE "public"."parked_conflict_resolution_choice" AS ENUM('source-wins', 'target-wins', 'propagate', 'sever');--> statement-breakpoint
CREATE TYPE "public"."parked_conflict_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "parked_conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_link_id" uuid NOT NULL,
	"sync_rule_id" uuid NOT NULL,
	"mapping_id" uuid NOT NULL,
	"kind" "parked_conflict_kind" NOT NULL,
	"side" "sync_field_state_side" NOT NULL,
	"field_path" text,
	"source_observed_hash" text,
	"target_observed_hash" text,
	"status" "parked_conflict_status" NOT NULL,
	"resolution_choice" "parked_conflict_resolution_choice",
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"source_native_id" text,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "parked_conflict_open_idx" ON "parked_conflict" USING btree ("record_link_id") WHERE "parked_conflict"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "parked_conflict_open_field_uq" ON "parked_conflict" USING btree ("record_link_id","side","kind","field_path") WHERE "parked_conflict"."status" = 'open' AND "parked_conflict"."field_path" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parked_conflict_open_delete_uq" ON "parked_conflict" USING btree ("record_link_id") WHERE "parked_conflict"."status" = 'open' AND "parked_conflict"."kind" = 'drifted-delete';