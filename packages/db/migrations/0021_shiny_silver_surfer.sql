CREATE TYPE "public"."adapter_request_cause" AS ENUM('not-yet-mapped', 'endpoint-disabled', 'mapping-stale', 'mapping-suspended', 'backend-disabled', 'mediator-transform-error', 'upstream-error');--> statement-breakpoint
CREATE TYPE "public"."adapter_write_outcome_status" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."aggregation_strategy" AS ENUM('single', 'fanout-merge', 'collection-union', 'fanout-first-success');--> statement-breakpoint
CREATE TYPE "public"."endpoint_strictness" AS ENUM('strict', 'degraded');--> statement-breakpoint
CREATE TABLE "adapter_write_outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"adapter_endpoint_id" uuid NOT NULL,
	"adapter_binding_id" uuid NOT NULL,
	"outcome" "adapter_write_outcome_status" NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"executed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD COLUMN "execution_order" integer;--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD COLUMN "depends_on_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD COLUMN "chain_inputs" jsonb;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "aggregation_strategy" "aggregation_strategy";--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "cache_ttl" integer;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "strictness" "endpoint_strictness";--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "post_merge_filters" jsonb;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "post_merge_sorts" jsonb;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "post_merge_pagination" jsonb;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD COLUMN "post_merge_dedup" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "related_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "related_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "cause" "adapter_request_cause";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "degraded" boolean;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "adapter_write_outcome" ADD CONSTRAINT "adapter_write_outcome_adapter_endpoint_id_adapter_endpoint_id_fk" FOREIGN KEY ("adapter_endpoint_id") REFERENCES "public"."adapter_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_write_outcome" ADD CONSTRAINT "adapter_write_outcome_adapter_binding_id_adapter_binding_id_fk" FOREIGN KEY ("adapter_binding_id") REFERENCES "public"."adapter_binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_write_outcome_endpoint_key_uq" ON "adapter_write_outcome" USING btree ("adapter_endpoint_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "adapter_write_outcome_expires_at_idx" ON "adapter_write_outcome" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD CONSTRAINT "adapter_binding_id_endpoint_uq" UNIQUE("id","adapter_endpoint_id");--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD CONSTRAINT "adapter_binding_depends_on_same_endpoint_fk" FOREIGN KEY ("depends_on_binding_id","adapter_endpoint_id") REFERENCES "public"."adapter_binding"("id","adapter_endpoint_id") ON DELETE no action ON UPDATE no action;