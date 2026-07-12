CREATE TYPE "public"."approved_mapping_status" AS ENUM('active', 'suspended', 'stale', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."audit_log_type" AS ENUM('poll-run', 'backfill-run', 'sync-execution', 'adapter-request', 'mapping-decision', 'credential-access');--> statement-breakpoint
CREATE TYPE "public"."conflict_policy" AS ENUM('manual-resolve');--> statement-breakpoint
CREATE TYPE "public"."mapping_decision" AS ENUM('accept', 'edit', 'reject', 'approve');--> statement-breakpoint
CREATE TYPE "public"."mapping_variant" AS ENUM('peer-peer', 'consumer-provider');--> statement-breakpoint
CREATE TYPE "public"."operation_action" AS ENUM('create', 'read', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."transform_kind" AS ENUM('rename', 'coerce', 'aggregate', 'expression');--> statement-breakpoint
CREATE TABLE "approved_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_spec_id" uuid NOT NULL,
	"target_spec_id" uuid NOT NULL,
	"source_app_id" uuid NOT NULL,
	"target_app_id" uuid NOT NULL,
	"variant" "mapping_variant" NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"status" "approved_mapping_status" NOT NULL,
	"counterpart_mapping_id" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "audit_log_type" NOT NULL,
	"actor" text NOT NULL,
	"decision" "mapping_decision",
	"related_proposal_id" uuid,
	"related_item_id" uuid,
	"related_mapping_id" uuid,
	"details" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"target_path" text NOT NULL,
	"transform" "transform_kind" NOT NULL,
	"transform_config" jsonb,
	"phase" "mapping_phase",
	"is_identity_key" boolean,
	"target_lookup_param_ref" text,
	"conflict_policy" "conflict_policy"
);
--> statement-breakpoint
CREATE TABLE "operation_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"source_operation_ref" text NOT NULL,
	"target_operation_ref" text NOT NULL,
	"action" "operation_action" NOT NULL,
	"target_id_param_ref" text
);
--> statement-breakpoint
CREATE TABLE "parameter_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_mapping_id" uuid NOT NULL,
	"source_param_ref" text NOT NULL,
	"target_param_ref" text NOT NULL,
	"transform" "transform_kind",
	"transform_config" jsonb
);
--> statement-breakpoint
ALTER TABLE "approved_mapping" ADD CONSTRAINT "approved_mapping_source_spec_id_api_spec_id_fk" FOREIGN KEY ("source_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_mapping" ADD CONSTRAINT "approved_mapping_target_spec_id_api_spec_id_fk" FOREIGN KEY ("target_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_mapping" ADD CONSTRAINT "approved_mapping_source_app_id_registered_app_id_fk" FOREIGN KEY ("source_app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_mapping" ADD CONSTRAINT "approved_mapping_target_app_id_registered_app_id_fk" FOREIGN KEY ("target_app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_mapping" ADD CONSTRAINT "approved_mapping_counterpart_mapping_id_approved_mapping_id_fk" FOREIGN KEY ("counterpart_mapping_id") REFERENCES "public"."approved_mapping"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mapping" ADD CONSTRAINT "field_mapping_mapping_id_approved_mapping_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."approved_mapping"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_mapping" ADD CONSTRAINT "operation_mapping_mapping_id_approved_mapping_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."approved_mapping"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_mapping" ADD CONSTRAINT "parameter_mapping_operation_mapping_id_operation_mapping_id_fk" FOREIGN KEY ("operation_mapping_id") REFERENCES "public"."operation_mapping"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approved_mapping_source_target_idx" ON "approved_mapping" USING btree ("source_spec_id","target_spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approved_mapping_active_direction_uq" ON "approved_mapping" USING btree ("source_spec_id","target_spec_id") WHERE "approved_mapping"."status" = 'active';--> statement-breakpoint
CREATE INDEX "audit_log_related_proposal_id_idx" ON "audit_log" USING btree ("related_proposal_id");--> statement-breakpoint
CREATE INDEX "audit_log_related_mapping_id_idx" ON "audit_log" USING btree ("related_mapping_id");--> statement-breakpoint
CREATE INDEX "field_mapping_mapping_id_idx" ON "field_mapping" USING btree ("mapping_id");--> statement-breakpoint
CREATE INDEX "operation_mapping_mapping_id_idx" ON "operation_mapping" USING btree ("mapping_id");--> statement-breakpoint
CREATE INDEX "parameter_mapping_operation_mapping_id_idx" ON "parameter_mapping" USING btree ("operation_mapping_id");