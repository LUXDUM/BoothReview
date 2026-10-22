import {
  bigint,
  bigserial,
  char,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * reviews: レビュー本体。
 * - author_hash は匿名IDを pepper で HMAC-SHA256 したもの (生の匿名IDは保存しない)
 * - status で公開/非表示/削除を管理 (物理削除はしない)
 * - (item_id, author_hash) ユニーク = 1つの商品あたり1匿名ID1件
 */
export const reviews = pgTable(
  "reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    itemId: bigint("item_id", { mode: "number" }).notNull(),
    authorHash: char("author_hash", { length: 64 }).notNull(),
    rating: smallint("rating").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("published"),
    hiddenReason: text("hidden_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reviews_item_author_uq").on(t.itemId, t.authorHash),
    index("reviews_list_idx").on(t.itemId, t.status, t.createdAt),
  ],
);

/**
 * reports: 通報。
 * - reporter_hash で同一人による重複通報を防ぐ (IPは保存しない)
 */
export const reports = pgTable(
  "reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reviewId: bigint("review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id),
    reporterHash: char("reporter_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reports_review_reporter_uq").on(t.reviewId, t.reporterHash),
    index("reports_review_idx").on(t.reviewId),
  ],
);

/**
 * review_stats: 集計テーブル。
 * レビュー件数が増えても GET summary が O(1) となるようトリガーでメンテナンスする。
 * (トリガーは migrations の SQL で定義)
 */
export const reviewStats = pgTable("review_stats", {
  itemId: bigint("item_id", { mode: "number" }).primaryKey(),
  reviewCount: integer("review_count").notNull().default(0),
  ratingSum: integer("rating_sum").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 将来の画像添付 (今回未実装) 用の拡張ポイント:
 * review_assets テーブルを reviews.id への外部キーで後から追加するだけでよい構造。
 * reviews 側には画像に関連する列を持たせない。
 */
