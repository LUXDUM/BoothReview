import { and, count, desc, eq, sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { reports, reviewStats, reviews } from "./schema.js";
import type {
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
    rating: row.rating,
    body: row.body,
    status: row.status as ReviewStatus,
    hiddenReason: row.hiddenReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

    async findReviewByAuthor(itemId, authorHashHex) {
      const rows = await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.itemId, itemId), eq(reviews.authorHash, authorHashHex)))
        .limit(1);
      return toRecord(rows[0]);
    },

    async upsertReview({ itemId, authorHashHex, rating, body }) {
      // 更新/新規どちらかを返すため、まず既存を探す (レース時は後段で仕上げる)
      const existing = await this.findReviewByAuthor(itemId, authorHashHex);
      if (existing) {
        const updated = await db
          .update(reviews)
          .set({ rating, body, updatedAt: new Date() })
          .where(eq(reviews.id, existing.id))
          .returning();
        return { review: toRecord(updated[0])!, created: false };
      }
      try {
        const inserted = await db
          .insert(reviews)
          .values({ itemId, authorHash: authorHashHex, rating, body })
          .returning();
        return { review: toRecord(inserted[0])!, created: true };
      } catch (e) {
        // UNIQUE(item_id, author_hash) の競合: 同一匿名IDの同時投稿 → 更新に寄せる
        if (isUniqueViolation(e)) {
          const again = await this.findReviewByAuthor(itemId, authorHashHex);
          if (again) {
            const updated = await db
              .update(reviews)
              .set({ rating, body, updatedAt: new Date() })
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
      const set: { rating?: number; body?: string; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (patch.rating !== undefined) set.rating = patch.rating;
      if (patch.body !== undefined) set.body = patch.body;
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

    async adminListReviews({ status, itemId, page, perPage }) {
      const conds = [];
      if (status) conds.push(eq(reviews.status, status));
      if (itemId !== undefined) conds.push(eq(reviews.itemId, itemId));
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
          reportCount: sql<number>`(
            SELECT COUNT(*) FROM reports WHERE reports.review_id = reviews.id
          )`,
        })
        .from(reviews)
        .where(where)
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
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
