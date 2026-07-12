ALTER TABLE "audit_log" ADD COLUMN "related_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "origin_app_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "span_id" text;