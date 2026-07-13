CREATE TYPE "public"."ordering_queue_status" AS ENUM('pending', 'processing', 'done', 'parked');--> statement-breakpoint
CREATE TABLE "ordering_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_key" text NOT NULL,
	"enqueue_seq" bigserial NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "ordering_queue_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ordering_queue_claim_idx" ON "ordering_queue" USING btree ("queue_key","enqueue_seq") WHERE "ordering_queue"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "ordering_queue_lease_idx" ON "ordering_queue" USING btree ("lease_expires_at") WHERE "ordering_queue"."status" = 'processing';