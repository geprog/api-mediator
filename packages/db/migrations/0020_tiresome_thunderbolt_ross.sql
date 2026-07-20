ALTER TYPE "public"."resource_binding_ref_kind" ADD VALUE 'recordAddressRef';--> statement-breakpoint
ALTER TABLE "record_link" ADD COLUMN "app_a_record_address" text;--> statement-breakpoint
ALTER TABLE "record_link" ADD COLUMN "app_b_record_address" text;