CREATE TYPE "public"."detection_job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "mapping_detection_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_spec_id" uuid NOT NULL,
	"status" "detection_job_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mapping_detection_job" ADD CONSTRAINT "mapping_detection_job_api_spec_id_api_spec_id_fk" FOREIGN KEY ("api_spec_id") REFERENCES "public"."api_spec"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mapping_detection_job_pending_idx" ON "mapping_detection_job" USING btree ("created_at","id") WHERE "mapping_detection_job"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_detection_job_active_spec_uq" ON "mapping_detection_job" USING btree ("api_spec_id") WHERE "mapping_detection_job"."status" in ('pending', 'running');