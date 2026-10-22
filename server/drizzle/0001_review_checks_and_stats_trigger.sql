-- レビューの CHECK 制約と review_stats のメンテナンストリガー
-- (drizzle-kit はトリガー/CHECK を出力しないため手書きのマイグレーション)

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_body_len_check" CHECK (char_length("body") BETWEEN 1 AND 20000);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_status_check" CHECK ("status" IN ('published', 'hidden', 'deleted'));

-- ---------- review_stats のメンテナンス ----------

CREATE OR REPLACE FUNCTION "review_stats_maintain"() RETURNS trigger AS $$
DECLARE
  t_item_id bigint;
BEGIN
  t_item_id := COALESCE(NEW."item_id", OLD."item_id");

  IF (TG_OP = 'DELETE') THEN
    DELETE FROM "review_stats" WHERE "item_id" = t_item_id AND NOT EXISTS (
      SELECT 1 FROM "reviews" WHERE "item_id" = t_item_id AND "status" = 'published'
    );
  END IF;

  INSERT INTO "review_stats" ("item_id", "review_count", "rating_sum", "updated_at")
  SELECT t_item_id, COUNT(*), COALESCE(SUM("rating"), 0), now()
  FROM "reviews"
  WHERE "item_id" = t_item_id AND "status" = 'published'
  ON CONFLICT ("item_id") DO UPDATE
    SET "review_count" = EXCLUDED."review_count",
        "rating_sum" = EXCLUDED."rating_sum",
        "updated_at" = now();

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reviews_stats_trigger" ON "reviews";
CREATE TRIGGER "reviews_stats_trigger"
AFTER INSERT OR UPDATE OF "rating", "status" OR DELETE ON "reviews"
FOR EACH ROW EXECUTE FUNCTION "review_stats_maintain"();
