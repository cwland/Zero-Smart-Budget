-- Replaces the short-lived email_log table (its entries now go in app_log)
DROP TABLE IF EXISTS "email_log";--> statement-breakpoint
CREATE TABLE "app_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"level" text NOT NULL,
	"source" text,
	"event" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE INDEX "app_log_at_idx" ON "app_log" USING btree ("at");