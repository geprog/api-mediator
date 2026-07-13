CREATE TYPE "public"."record_link_established_by" AS ENUM('create-propagation', 'identity-match', 'manual');--> statement-breakpoint
CREATE TYPE "public"."record_link_status" AS ENUM('active', 'tombstoned', 'archived');--> statement-breakpoint
CREATE TYPE "public"."record_link_tombstone_reason" AS ENUM('propagated-delete', 'observed-delete');--> statement-breakpoint
CREATE TYPE "public"."sync_field_state_side" AS ENUM('A', 'B');--> statement-breakpoint
CREATE TYPE "public"."sync_field_state_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "record_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_a_id" uuid NOT NULL,
	"app_a_native_id" text NOT NULL,
	"app_b_id" uuid NOT NULL,
	"app_b_native_id" text NOT NULL,
	"resource_pair_ref" text NOT NULL,
	"established_by" "record_link_established_by" NOT NULL,
	"status" "record_link_status" NOT NULL,
	"tombstone_reason" "record_link_tombstone_reason",
	"establishing_queue_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_field_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_link_id" uuid NOT NULL,
	"side" "sync_field_state_side" NOT NULL,
	"field_path" text NOT NULL,
	"last_synced_hash" text,
	"last_synced_at" timestamp with time zone,
	"observed_hash" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_change_timestamp" timestamp with time zone,
	"last_written_by_mapping_id" uuid,
	"status" "sync_field_state_status" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_field_state" ADD CONSTRAINT "sync_field_state_record_link_id_record_link_id_fk" FOREIGN KEY ("record_link_id") REFERENCES "public"."record_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "record_link_active_side_a_uq" ON "record_link" USING btree ("resource_pair_ref","app_a_id","app_a_native_id") WHERE "record_link"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "record_link_active_side_b_uq" ON "record_link" USING btree ("resource_pair_ref","app_b_id","app_b_native_id") WHERE "record_link"."status" = 'active';--> statement-breakpoint
CREATE INDEX "record_link_side_a_idx" ON "record_link" USING btree ("resource_pair_ref","app_a_id","app_a_native_id");--> statement-breakpoint
CREATE INDEX "record_link_side_b_idx" ON "record_link" USING btree ("resource_pair_ref","app_b_id","app_b_native_id");--> statement-breakpoint
CREATE INDEX "sync_field_state_record_link_id_idx" ON "sync_field_state" USING btree ("record_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_field_state_link_side_field_uq" ON "sync_field_state" USING btree ("record_link_id","side","field_path");