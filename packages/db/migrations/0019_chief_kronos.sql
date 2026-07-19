CREATE TYPE "public"."poll_scope_mode" AS ENUM('cross-scope', 'per-scope-enumerated', 'per-scope-pinned');--> statement-breakpoint
CREATE TABLE "poll_scope_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_rule_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"cursor" text,
	"last_run_at" timestamp with time zone,
	"last_snapshot_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "poll_snapshot_sync_rule_uq";--> statement-breakpoint
ALTER TABLE "poll_snapshot" ADD COLUMN "scope_key" text DEFAULT '__cross_scope__' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_rule" ADD COLUMN "poll_scope_mode" "poll_scope_mode";--> statement-breakpoint
ALTER TABLE "poll_scope_state" ADD CONSTRAINT "poll_scope_state_sync_rule_id_sync_rule_id_fk" FOREIGN KEY ("sync_rule_id") REFERENCES "public"."sync_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_scope_state" ADD CONSTRAINT "poll_scope_state_last_snapshot_ref_poll_snapshot_id_fk" FOREIGN KEY ("last_snapshot_ref") REFERENCES "public"."poll_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poll_scope_state_rule_scope_uq" ON "poll_scope_state" USING btree ("sync_rule_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_snapshot_rule_scope_uq" ON "poll_snapshot" USING btree ("sync_rule_id","scope_key");