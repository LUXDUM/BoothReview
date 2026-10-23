import { and, avg, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { authorBlocks, reports, reviewStats, reviews } from "./schema.js";
import type {
  AuthorBlockRecord,
  ReviewRecord,
  ReviewRepository,
  ReviewStatus,
  Summary,
} from "../lib/repo.js";
type Db = NodePgDatabase<Record<string, never>>;

type Row = {
  id: number;
  itemId: number;
  authorHash: string;
  rating: number;
  body: string;
  status: string;
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: Row | undefined | null): ReviewRecord | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    itemId: Number(row.itemId),
    authorHash: row.authorHash,
    rating: row.rating,
    body: row.body,
    status: row.status as ReviewStatus,
    hiddenReason: row.hiddenReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 管理機能共通: 通報数。生TABLE名で書く (sql テンプレート内の列補間はテーブル名が失われるため) */
const REPORT_COUNT_SQL = sql`(SELECT COUNT(*) FROM reports WHERE reports.review_id = reviews.id)`;

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

export function createDrizzleRepository(db: Db): ReviewRepository {
  return {
    async ping(): Promise<void> {
      await db.execute(sql`SELECT 1`);
    },

    async listPublishedReviews(itemId, page, perPage) {
      const where = and(eq(reviews.itemId, itemId), eq(reviews.status, "published"));
      const rows = await db
        .select()
        .from(reviews)
        .where(where)
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(perPage)
        .offset((page - 1) * perPage);
      const totalRows = await db
        .select({ total: count() })
        .from(reviews)
        .where(where);
      return {
        items: rows.map((r) => toRecord(r)!),
        total: Number(totalRows[0]?.total ?? 0),
      };
    },

    async getSummary(itemId): Promise<Summary> {
      const rows = await db
        .select()
        .from(reviewStats)
        .where(eq(reviewStats.itemId, itemId))
        .limit(1);
      const row = rows[0];
      if (!row) return { reviewCount: 0, ratingSum: 0 };
      return { reviewCount: row.reviewCount, ratingSum: row.ratingSum };
    },

    async listSummaries(itemIds) {
      if (itemIds.length === 0) return [];
      const rows = await db
        .select()
        .from(reviewStats)
        .where(inArray(reviewStats.itemId, itemIds));
      return rows.map((r) => ({
        itemId: Number(r.itemId),
        reviewCount: r.reviewCount,
        ratingSum: r.ratingSum,
      }));
    },

    async getShopSummary(shop): Promise<Summary> {
      const rows = await db
        .select({ reviewsCount: count(), ratingSum: sql`COALESCE(SUM(${reviews.rating}), 0)` })
        .from(reviews)
        .where(and(eq(reviews.shop, shop), eq(reviews.status, "published")));
      const row = rows[0];
      if (!row) return { reviewCount: 0, ratingSum: 0 };
      return { reviewCount: Number(row.reviewsCount), ratingSum: Number(row.ratingSum) };
    },

    async listShopReviews(shop, page, perPage) {
      const where = and(eq(reviews.shop, shop), eq(reviews.status, "published"));
      const rows = await db
        .select()
        .from(reviews)
        .where(where)
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(perPage)
        .offset((page - 1) * perPage);
      const totalRows = await db.select({ total: count() }).from(reviews).where(where);
      return {
        items: rows.map((r) => toRecord(r)!),
        total: Number(totalRows[0]?.total ?? 0),
      };
    },

    async findReviewByAuthor(itemId, authorHashHex) {
      const rows = await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.itemId, itemId), eq(reviews.authorHash, authorHashHex)))
        .limit(1);
      return toRecord(rows[0]);
    },

    async upsertReview({ itemId, authorHashHex, rating, body, shop }) {
      // 更新/新規どちらかを返すため、まず既存を探す (レース時は後段で仕上げる)
      const existing = await this.findReviewByAuthor(itemId, authorHashHex);
      if (existing) {
        // ユーザー自身の削除 (deleted) からの再投稿は「新規投稿」として復活させる。
        // 管理者/通報による hidden は報告スパム対策のため復活させない (仕様 5.2)。
        const revive = existing.status === "deleted";
        const updated = await db
          .update(reviews)
          .set({
            rating,
            body,
            updatedAt: new Date(),
            ...(revive ? { status: "published" as const, hiddenReason: null } : {}),
            // ショップは指定があったときだけ更新 (旧データの紐付けを消さない)
            ...(shop !== undefined ? { shop } : {}),
          })
          .where(eq(reviews.id, existing.id))
          .returning();
        return { review: toRecord(updated[0])!, created: false };
      }
      try {
        const inserted = await db
          .insert(reviews)
          .values({ itemId, authorHash: authorHashHex, rating, body, ...(shop !== undefined ? { shop } : {}) })
          .returning();
        return { review: toRecord(inserted[0])!, created: true };
      } catch (e) {
        // UNIQUE(item_id, author_hash) の競合: 同一匿名IDの同時投稿 → 更新に寄せる
        if (isUniqueViolation(e)) {
          const again = await this.findReviewByAuthor(itemId, authorHashHex);
          if (again) {
            const reviveAgain = again.status === "deleted";
            const updated = await db
              .update(reviews)
              .set({
                rating,
                body,
                updatedAt: new Date(),
                ...(reviveAgain ? { status: "published" as const, hiddenReason: null } : {}),
                ...(shop !== undefined ? { shop } : {}),
              })
              .where(eq(reviews.id, again.id))
              .returning();
            return { review: toRecord(updated[0])!, created: false };
          }
        }
        throw e;
      }
    },

    async getReview(id) {
      const rows = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
      return toRecord(rows[0]);
    },

    async updateOwnReview(id, authorHashHex, patch) {
      const rows = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
      const row = rows[0];
      const review = toRecord(row);
      if (!review) return { found: false, owned: false, review: null };
      if (row && row.authorHash !== authorHashHex) {
        return { found: true, owned: false, review: null };
      }
      const set: { rating?: number; body?: string; shop?: string; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (patch.rating !== undefined) set.rating = patch.rating;
      if (patch.body !== undefined) set.body = patch.body;
      if (patch.shop !== undefined) set.shop = patch.shop;
      const updated = await db
        .update(reviews)
        .set(set)
        .where(eq(reviews.id, id))
        .returning();
      return { found: true, owned: true, review: toRecord(updated[0]) };
    },

    async deleteOwnReview(id, authorHashHex) {
      const rows = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
      const row = rows[0];
      if (!row) return { found: false, owned: false };
      if (row.authorHash !== authorHashHex) return { found: true, owned: false };
      await db
        .update(reviews)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(reviews.id, id));
      return { found: true, owned: true };
    },

    async addReport(reviewId, reporterHashHex) {
      const inserted = await db
        .insert(reports)
        .values({ reviewId, reporterHash: reporterHashHex })
        .onConflictDoNothing()
        .returning({ id: reports.id });
      return { added: inserted.length > 0 };
    },

    async countReports(reviewId) {
      const rows = await db
        .select({ total: count() })
        .from(reports)
        .where(eq(reports.reviewId, reviewId));
      return Number(rows[0]?.total ?? 0);
    },

    async setStatus(reviewId, status, hiddenReason) {
      const updated = await db
        .update(reviews)
        .set({ status, hiddenReason, updatedAt: new Date() })
        .where(eq(reviews.id, reviewId))
        .returning({ id: reviews.id });
      return updated.length > 0;
    },

    async adminListReviews({ status, itemId, query, authorHashHex, order, page, perPage }) {
      const conds = [];
      if (status) conds.push(eq(reviews.status, status));
      if (itemId !== undefined) conds.push(eq(reviews.itemId, itemId));
      if (query) conds.push(ilike(reviews.body, `%${escapeLike(query)}%`));
      if (authorHashHex) conds.push(eq(reviews.authorHash, authorHashHex));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const rows = await db
        .select({
          id: reviews.id,
          itemId: reviews.itemId,
          authorHash: reviews.authorHash,
          rating: reviews.rating,
          body: reviews.body,
          status: reviews.status,
          hiddenReason: reviews.hiddenReason,
          createdAt: reviews.createdAt,
          updatedAt: reviews.updatedAt,
          reportCount: REPORT_COUNT_SQL,
        })
        .from(reviews)
        .where(where)
        .orderBy(
          ...(order === "reports"
            ? [sql`${REPORT_COUNT_SQL} desc`, desc(reviews.id)]
            : [desc(reviews.createdAt), desc(reviews.id)]),
        )
        .limit(perPage)
        .offset((page - 1) * perPage);
      const totalRows = await db.select({ total: count() }).from(reviews).where(where);
      return {
        items: rows.map((r) => ({
          ...toRecord(r)!,
          reportCount: Number(r.reportCount),
        })),
        total: Number(totalRows[0]?.total ?? 0),
      };
    },

    async adminStats() {
      // --- status 別件数 ---
      const statusRows = await db
        .select({ status: reviews.status, count: count() })
        .from(reviews)
        .groupBy(reviews.status);
      const counts = { total: 0, published: 0, hidden: 0, deleted: 0 };
      for (const row of statusRows) {
        const key = row.status as ReviewStatus;
        counts[key] = Number(row.count);
        counts.total += Number(row.count);
      }

      // --- 公開レビューの平均 / 星分布 ---
      const avgRows = await db
        .select({ avgRating: avg(reviews.rating) })
        .from(reviews)
        .where(eq(reviews.status, "published"));
      const avgRating = avgRows[0]?.avgRating === undefined || avgRows[0] === undefined
        ? null
        : Number(avgRows[0].avgRating);
      const distRows = await db
        .select({ rating: reviews.rating, count: count() })
        .from(reviews)
        .where(eq(reviews.status, "published"))
        .groupBy(reviews.rating);
      const ratingDistribution = [0, 0, 0, 0, 0];
      for (const row of distRows) {
        const r = Number(row.rating);
        if (r >= 1 && r <= 5) ratingDistribution[r - 1] = Number(row.count);
      }

      // --- 通報 ---
      const reportRows = await db.select({ total: count() }).from(reports);
      const reportTotal = Number(reportRows[0]?.total ?? 0);
      const topRows = await db
        .select({
          id: reviews.id,
          itemId: reviews.itemId,
          authorHash: reviews.authorHash,
          rating: reviews.rating,
          body: reviews.body,
          status: reviews.status,
          hiddenReason: reviews.hiddenReason,
          createdAt: reviews.createdAt,
          updatedAt: reviews.updatedAt,
          reportCount: REPORT_COUNT_SQL,
        })
        .from(reviews)
        .orderBy(sql`${REPORT_COUNT_SQL} desc`, desc(reviews.id))
        .limit(10);
      const topReported = topRows
        .map((r) => ({ ...toRecord(r)!, reportCount: Number(r.reportCount) }))
        .filter((r) => r.reportCount > 0);

      // --- 直近30日の日次投稿数 (ゼロ埋め) ---
      const trendRows = await db.execute(
        sql`SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
            FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
            LEFT JOIN (
              SELECT date_trunc('day', created_at) AS day, COUNT(*) AS count
              FROM reviews GROUP BY 1
            ) c ON c.day = d.day
            ORDER BY d.day`,
      );
      const trend = (trendRows.rows as Array<{ day: string; count: number }>).map((r) => ({
        day: String(r.day),
        count: Number(r.count),
      }));

      // --- 公開レビューの多いアイテム ---
      const itemRows = await db
        .select({ itemId: reviews.itemId, count: count() })
        .from(reviews)
        .where(eq(reviews.status, "published"))
        .groupBy(reviews.itemId)
        .orderBy(sql`count(*) desc`)
        .limit(10);
      const topItems = itemRows.map((r) => ({ itemId: Number(r.itemId), count: Number(r.count) }));

      // --- DB サイズ ---
      let dbSizeBytes: number | null = null;
      try {
        const sizeRows = await db.execute(
          sql`SELECT pg_database_size(current_database())::bigint AS size`,
        );
        const r = (sizeRows.rows as Array<{ size: string | number }>)[0];
        dbSizeBytes = r ? Number(r.size) : null;
      } catch {
        dbSizeBytes = null;
      }

      // --- テーブル別サイズ ---
      let tableSizes: Array<{ table: string; bytes: number }> = [];
      try {
        const tRows = await db.execute(
          sql`SELECT c.relname AS table, pg_total_relation_size(c.oid)::bigint AS bytes
              FROM pg_class c
              WHERE c.relname IN ('reviews', 'reports', 'review_stats') AND c.relkind = 'r'`,
        );
        tableSizes = (tRows.rows as Array<{ table: string; bytes: string | number }>).map((r) => ({
          table: String(r.table),
          bytes: Number(r.bytes),
        }));
      } catch {
        tableSizes = [];
      }

      return {
        counts,
        avgRating,
        ratingDistribution,
        reportTotal,
        topReported,
        trend,
        topItems,
        dbSizeBytes,
        tableSizes,
      };
    },
    async listAuthorBlocks(): Promise<AuthorBlockRecord[]> {
      const rows = await db
        .select({
          authorHash: authorBlocks.authorHash,
          reason: authorBlocks.reason,
          createdAt: authorBlocks.createdAt,
          // BAN解除の参照用に、この匿名IDのレビュー1件 (最古) の ID を添える。
          // 注意: sql テンプレート内の列補間はテーブル名が失われるため、相関は生テーブル名で書く
          sampleReviewId: sql<number | null>`(
            SELECT MIN(r.id) FROM reviews r WHERE r.author_hash = author_blocks.author_hash
          )`,
        })
        .from(authorBlocks)
        .orderBy(desc(authorBlocks.createdAt));
      return rows.map((r) => ({
        authorHash: r.authorHash,
        reason: r.reason,
        createdAt: r.createdAt,
        sampleReviewId: r.sampleReviewId === null || r.sampleReviewId === undefined ? null : Number(r.sampleReviewId),
      }));
    },

    async isAuthorBlocked(authorHashHex) {
      const rows = await db
        .select({ x: authorBlocks.authorHash })
        .from(authorBlocks)
        .where(eq(authorBlocks.authorHash, authorHashHex))
        .limit(1);
      return rows.length > 0;
    },

    async blockAuthor(authorHashHex, reason) {
      const inserted = await db
        .insert(authorBlocks)
        .values({ authorHash: authorHashHex, reason })
        .onConflictDoNothing()
        .returning({ authorHash: authorBlocks.authorHash });
      return inserted.length > 0;
    },

    async unblockAuthor(authorHashHex) {
      const deleted = await db
        .delete(authorBlocks)
        .where(eq(authorBlocks.authorHash, authorHashHex))
        .returning({ authorHash: authorBlocks.authorHash });
      return deleted.length > 0;
    },
  };
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "23505"
  );
}
