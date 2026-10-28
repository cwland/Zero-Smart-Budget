ALTER TABLE "plaid_items" ADD COLUMN "import_from" date;--> statement-breakpoint
UPDATE "plaid_items" SET "import_from" = date_trunc('month', now())::date;--> statement-breakpoint
ALTER TABLE "plaid_items" ALTER COLUMN "import_from" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "plaid_transaction_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "plaid_account_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_plaid_transaction_id_unique" UNIQUE("plaid_transaction_id");