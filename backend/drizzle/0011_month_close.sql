CREATE TYPE "public"."fund_kind" AS ENUM('sinking', 'goal');--> statement-breakpoint
ALTER TYPE "public"."fund_entry_kind" ADD VALUE 'month_close';--> statement-breakpoint
ALTER TABLE "budget_months" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_months" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "budget_months" ADD COLUMN "close_result" jsonb;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD COLUMN "close_month_id" integer;--> statement-breakpoint
ALTER TABLE "income_items" ADD COLUMN "rollover_from_month_id" integer;--> statement-breakpoint
ALTER TABLE "sinking_funds" ADD COLUMN "kind" "fund_kind" DEFAULT 'sinking' NOT NULL;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_close_month_id_budget_months_id_fk" FOREIGN KEY ("close_month_id") REFERENCES "public"."budget_months"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_items" ADD CONSTRAINT "income_items_rollover_from_month_id_budget_months_id_fk" FOREIGN KEY ("rollover_from_month_id") REFERENCES "public"."budget_months"("id") ON DELETE cascade ON UPDATE no action;