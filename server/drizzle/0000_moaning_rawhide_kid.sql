CREATE TABLE IF NOT EXISTS "reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"review_id" bigint NOT NULL,
	"reporter_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_stats" (
	"item_id" bigint PRIMARY KEY NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"rating_sum" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" bigint NOT NULL,
	"author_hash" char(64) NOT NULL,
	"rating" smallint NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"hidden_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_review_reporter_uq" ON "reports" USING btree ("review_id","reporter_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_review_idx" ON "reports" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_item_author_uq" ON "reviews" USING btree ("item_id","author_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_list_idx" ON "reviews" USING btree ("item_id","status","created_at");