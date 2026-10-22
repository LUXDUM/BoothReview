ALTER TABLE "reviews" ADD COLUMN "shop" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_shop_list_idx" ON "reviews" USING btree ("shop","status","created_at");