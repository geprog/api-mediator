CREATE TYPE "public"."adapter_binding_role" AS ENUM('primary', 'fallback', 'supplement');--> statement-breakpoint
CREATE TYPE "public"."adapter_binding_status" AS ENUM('active', 'proposed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."adapter_endpoint_status" AS ENUM('active', 'composition-required', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."graph_edge_type" AS ENUM('sync', 'adapter-dependency');--> statement-breakpoint
CREATE TYPE "public"."sync_rule_status" AS ENUM('enabled', 'disabled');--> statement-breakpoint
CREATE TABLE "adapter_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_endpoint_id" uuid NOT NULL,
	"backend_app_id" uuid NOT NULL,
	"backend_operation_id" text NOT NULL,
	"approved_mapping_id" uuid NOT NULL,
	"role" "adapter_binding_role" NOT NULL,
	"status" "adapter_binding_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapter_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consumer_app_id" uuid NOT NULL,
	"consumer_operation_id" text NOT NULL,
	"status" "adapter_endpoint_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"type" "graph_edge_type" NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approved_mapping_id" uuid NOT NULL,
	"resource_pair_ref" text NOT NULL,
	"status" "sync_rule_status" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD CONSTRAINT "adapter_binding_adapter_endpoint_id_adapter_endpoint_id_fk" FOREIGN KEY ("adapter_endpoint_id") REFERENCES "public"."adapter_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD CONSTRAINT "adapter_binding_backend_app_id_registered_app_id_fk" FOREIGN KEY ("backend_app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_binding" ADD CONSTRAINT "adapter_binding_approved_mapping_id_approved_mapping_id_fk" FOREIGN KEY ("approved_mapping_id") REFERENCES "public"."approved_mapping"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_endpoint" ADD CONSTRAINT "adapter_endpoint_consumer_app_id_registered_app_id_fk" FOREIGN KEY ("consumer_app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edge" ADD CONSTRAINT "graph_edge_source_node_id_registered_app_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edge" ADD CONSTRAINT "graph_edge_target_node_id_registered_app_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD CONSTRAINT "sync_rule_approved_mapping_id_approved_mapping_id_fk" FOREIGN KEY ("approved_mapping_id") REFERENCES "public"."approved_mapping"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adapter_binding_adapter_endpoint_id_idx" ON "adapter_binding" USING btree ("adapter_endpoint_id");--> statement-breakpoint
CREATE INDEX "adapter_binding_approved_mapping_id_idx" ON "adapter_binding" USING btree ("approved_mapping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_binding_endpoint_backend_mapping_uq" ON "adapter_binding" USING btree ("adapter_endpoint_id","backend_app_id","backend_operation_id","approved_mapping_id");--> statement-breakpoint
CREATE INDEX "adapter_endpoint_consumer_app_id_idx" ON "adapter_endpoint" USING btree ("consumer_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_endpoint_consumer_operation_uq" ON "adapter_endpoint" USING btree ("consumer_app_id","consumer_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edge_nodes_type_uq" ON "graph_edge" USING btree ("source_node_id","target_node_id","type");--> statement-breakpoint
CREATE INDEX "sync_rule_approved_mapping_id_idx" ON "sync_rule" USING btree ("approved_mapping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_rule_mapping_resource_pair_uq" ON "sync_rule" USING btree ("approved_mapping_id","resource_pair_ref");