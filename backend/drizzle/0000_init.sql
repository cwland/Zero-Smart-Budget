CREATE TYPE "public"."transaction_type" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "budget_months" (
	"id" serial PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"month_id" integer NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"month_id" integer NOT NULL,
	"name" text NOT NULL,
	"planned_cents" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"name" text NOT NULL,
	"planned_cents" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"sinking_fund_id" integer
);
--> statement-breakpoint
CREATE TABLE "sinking_funds" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"target_cents" integer,
	"starting_balance_cents" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"line_item_id" integer,
	"income_item_id" integer,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"merchant" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"type" "transaction_type" DEFAULT 'expense' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "category_groups" ADD CONSTRAINT "category_groups_month_id_budget_months_id_fk" FOREIGN KEY ("month_id") REFERENCES "public"."budget_months"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_items" ADD CONSTRAINT "income_items_month_id_budget_months_id_fk" FOREIGN KEY ("month_id") REFERENCES "public"."budget_months"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_group_id_category_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_sinking_fund_id_sinking_funds_id_fk" FOREIGN KEY ("sinking_fund_id") REFERENCES "public"."sinking_funds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_line_item_id_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."line_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_income_item_id_income_items_id_fk" FOREIGN KEY ("income_item_id") REFERENCES "public"."income_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_months_year_month_idx" ON "budget_months" USING btree ("year","month");--> statement-breakpoint
CREATE INDEX "category_groups_month_idx" ON "category_groups" USING btree ("month_id");--> statement-breakpoint
CREATE INDEX "income_items_month_idx" ON "income_items" USING btree ("month_id");--> statement-breakpoint
CREATE INDEX "line_items_group_idx" ON "line_items" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "line_items_fund_idx" ON "line_items" USING btree ("sinking_fund_id");--> statement-breakpoint
CREATE INDEX "splits_transaction_idx" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "splits_line_item_idx" ON "transaction_splits" USING btree ("line_item_id");--> statement-breakpoint
CREATE INDEX "splits_income_item_idx" ON "transaction_splits" USING btree ("income_item_id");--> statement-breakpoint
CREATE INDEX "transactions_date_idx" ON "transactions" USING btree ("date");