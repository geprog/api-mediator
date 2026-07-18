CREATE TYPE "public"."scope_link_established_by" AS ENUM('constant', 'identity-match', 'manual');--> statement-breakpoint
CREATE TYPE "public"."scope_link_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "scope_correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_pair_ref" text NOT NULL,
	"scope_identity_key" jsonb NOT NULL,
	"target_container_ref" jsonb NOT NULL,
	"source_container_ref" jsonb,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scope_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_correspondence_id" uuid NOT NULL,
	"app_a_id" uuid NOT NULL,
	"app_a_scope_key" jsonb NOT NULL,
	"app_b_id" uuid NOT NULL,
	"app_b_scope_key" jsonb NOT NULL,
	"resource_pair_ref" text NOT NULL,
	"established_by" "scope_link_established_by" NOT NULL,
	"status" "scope_link_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_link" ADD COLUMN "scope_ref" jsonb;--> statement-breakpoint
ALTER TABLE "scope_link" ADD CONSTRAINT "scope_link_scope_correspondence_id_scope_correspondence_id_fk" FOREIGN KEY ("scope_correspondence_id") REFERENCES "public"."scope_correspondence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scope_correspondence_resource_pair_uq" ON "scope_correspondence" USING btree ("resource_pair_ref");--> statement-breakpoint
CREATE INDEX "scope_link_correspondence_idx" ON "scope_link" USING btree ("scope_correspondence_id");--> statement-breakpoint
CREATE INDEX "scope_link_side_a_idx" ON "scope_link" USING btree ("resource_pair_ref","app_a_id");--> statement-breakpoint
CREATE INDEX "scope_link_side_b_idx" ON "scope_link" USING btree ("resource_pair_ref","app_b_id");