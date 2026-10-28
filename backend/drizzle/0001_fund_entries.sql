CREATE TYPE "public"."fund_entry_kind" AS ENUM('budgeted', 'spent', 'adjustment');--> statement-breakpoint
CREATE TABLE "fund_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"fund_id" integer NOT NULL,
	"kind" "fund_entry_kind" NOT NULL,
	"date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"description" text,
	"line_item_id" integer,
	"transaction_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_fund_id_sinking_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."sinking_funds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_line_item_id_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."line_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_entries" ADD CONSTRAINT "fund_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fund_entries_fund_date_idx" ON "fund_entries" USING btree ("fund_id","date");--> statement-breakpoint
CREATE INDEX "fund_entries_line_item_idx" ON "fund_entries" USING btree ("line_item_id");--> statement-breakpoint
CREATE INDEX "fund_entries_transaction_idx" ON "fund_entries" USING btree ("transaction_id");--> statement-breakpoint
-- Backfill: build the history from what's linked today, so existing fund balances don't change
INSERT INTO "fund_entries" ("fund_id", "kind", "date", "amount_cents", "description", "line_item_id")
SELECT li."sinking_fund_id", 'budgeted', make_date(bm."year", bm."month", 1), li."planned_cents", li."name", li."id"
FROM "line_items" li
JOIN "category_groups" cg ON cg."id" = li."group_id"
JOIN "budget_months" bm ON bm."id" = cg."month_id"
WHERE li."sinking_fund_id" IS NOT NULL AND li."planned_cents" <> 0;
--> statement-breakpoint
INSERT INTO "fund_entries" ("fund_id", "kind", "date", "amount_cents", "description", "line_item_id", "transaction_id")
SELECT li."sinking_fund_id", 'spent', t."date", -SUM(s."amount_cents"), t."merchant", li."id", t."id"
FROM "transaction_splits" s
JOIN "line_items" li ON li."id" = s."line_item_id"
JOIN "transactions" t ON t."id" = s."transaction_id"
WHERE li."sinking_fund_id" IS NOT NULL
GROUP BY li."sinking_fund_id", t."date", t."merchant", li."id", t."id";
