CREATE TYPE "public"."api_spec_role" AS ENUM('PROVIDER', 'CONSUMER');--> statement-breakpoint
CREATE TYPE "public"."api_spec_status" AS ENUM('active', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."credential_type" AS ENUM('apiKey', 'oauth2', 'basicAuth', 'adapterToken', 'custom');--> statement-breakpoint
CREATE TYPE "public"."registered_app_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."resource_binding_ref_kind" AS ENUM('nativeIdRef', 'collectionReadRef', 'paginationRef', 'deltaCursorRef', 'deltaDeletionRef', 'changeTimestampRef');--> statement-breakpoint
CREATE TABLE "api_spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"role" "api_spec_role" NOT NULL,
	"raw_document" jsonb NOT NULL,
	"parsed_ir" jsonb NOT NULL,
	"analysis_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"status" "api_spec_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"type" "credential_type" NOT NULL,
	"encrypted_payload" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registered_app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "registered_app_status" NOT NULL,
	"base_url" text,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_spec_id" uuid NOT NULL,
	"resource_ref" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_binding_ref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_binding_id" uuid NOT NULL,
	"ref_kind" "resource_binding_ref_kind" NOT NULL,
	"value" jsonb NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_spec" ADD CONSTRAINT "api_spec_app_id_registered_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_app_id_registered_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."registered_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_binding" ADD CONSTRAINT "resource_binding_api_spec_id_api_spec_id_fk" FOREIGN KEY ("api_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_binding_ref" ADD CONSTRAINT "resource_binding_ref_resource_binding_id_resource_binding_id_fk" FOREIGN KEY ("resource_binding_id") REFERENCES "public"."resource_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_spec_app_id_idx" ON "api_spec" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "credential_app_id_idx" ON "credential" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "resource_binding_api_spec_id_idx" ON "resource_binding" USING btree ("api_spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_binding_ref_binding_kind_uq" ON "resource_binding_ref" USING btree ("resource_binding_id","ref_kind");