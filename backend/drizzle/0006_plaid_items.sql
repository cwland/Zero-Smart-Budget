CREATE TYPE "public"."plaid_item_status" AS ENUM('ok', 'login_required', 'error');--> statement-breakpoint
CREATE TABLE "plaid_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"plaid_item_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text NOT NULL,
	"subtype" text,
	"import_transactions" boolean DEFAULT true NOT NULL,
	"current_balance_cents" integer,
	"available_balance_cents" integer,
	CONSTRAINT "plaid_accounts_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "plaid_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"env" text NOT NULL,
	"institution_id" text,
	"institution_name" text NOT NULL,
	"status" "plaid_item_status" DEFAULT 'ok' NOT NULL,
	"error_code" text,
	"error_message" text,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plaid_items_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plaid_accounts_item_idx" ON "plaid_accounts" USING btree ("plaid_item_id");