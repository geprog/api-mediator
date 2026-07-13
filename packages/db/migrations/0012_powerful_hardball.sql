CREATE TYPE "public"."audit_log_status" AS ENUM('success', 'failure', 'skipped-loop', 'skipped-policy', 'conflict');--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "status" "audit_log_status";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "related_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "record_link_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "source_native_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "ordering_queue" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registered_app" ADD COLUMN "outbound_limits" jsonb;--> statement-breakpoint
CREATE INDEX "audit_log_idempotency_key_idx" ON "audit_log" USING btree ("idempotency_key","timestamp") WHERE "audit_log"."idempotency_key" IS NOT NULL;