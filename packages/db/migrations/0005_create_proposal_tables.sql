CREATE TYPE "public"."mapping_phase" AS ENUM('request', 'response');--> statement-breakpoint
CREATE TYPE "public"."mapping_proposal_item_kind" AS ENUM('operation', 'field', 'parameter');--> statement-breakpoint
CREATE TYPE "public"."mapping_proposal_status" AS ENUM('pending', 'partially_approved', 'approved', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TABLE "mapping_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_spec_id" uuid NOT NULL,
	"target_spec_id" uuid NOT NULL,
	"generated_by" jsonb NOT NULL,
	"shortlist_result" jsonb,
	"status" "mapping_proposal_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mapping_proposal_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" "mapping_proposal_item_kind" NOT NULL,
	"source_ref" jsonb NOT NULL,
	"target_ref" jsonb,
	"phase" "mapping_phase",
	"transform_suggestion" jsonb,
	"confidence_score" real NOT NULL,
	"ambiguous_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unmapped" boolean NOT NULL,
	"rationale" text NOT NULL,
	"review_state" "review_state" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mapping_proposal" ADD CONSTRAINT "mapping_proposal_source_spec_id_api_spec_id_fk" FOREIGN KEY ("source_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_proposal" ADD CONSTRAINT "mapping_proposal_target_spec_id_api_spec_id_fk" FOREIGN KEY ("target_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_proposal_item" ADD CONSTRAINT "mapping_proposal_item_proposal_id_mapping_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."mapping_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mapping_proposal_source_spec_id_idx" ON "mapping_proposal" USING btree ("source_spec_id");--> statement-breakpoint
CREATE INDEX "mapping_proposal_source_target_idx" ON "mapping_proposal" USING btree ("source_spec_id","target_spec_id");--> statement-breakpoint
CREATE INDEX "mapping_proposal_item_proposal_id_idx" ON "mapping_proposal_item" USING btree ("proposal_id");