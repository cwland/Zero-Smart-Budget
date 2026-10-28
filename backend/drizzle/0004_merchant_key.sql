ALTER TABLE "transactions" ADD COLUMN "merchant_key" text;--> statement-breakpoint
CREATE INDEX "transactions_merchant_key_idx" ON "transactions" USING btree ("merchant_key");