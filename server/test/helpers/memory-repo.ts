import type {
  ReviewRecord,
  ReviewRepository,
  ReviewStatus,
} from "../src/lib/repo.js";

/**
 * tests 用のインメモリ実装。
 * Drizzle 実装と同じセマンティクス (upsert・所有権・論理削除・通報の重複) を再現する。
 */

type Row = {
  id: number;
  itemId: number;
  authorHash: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryDb = {
  reviews: Row[];
  reports: Array<{ id: number; reviewId: number; reporterHash: string; createdAt: Date }>;
};

function clone(r: Row): ReviewRecord {
  return {
    id: r.id,
    itemId: r.itemId,
    rating: r.rating,
    body: r.body,
    status: r.status,
    hiddenReason: r.hiddenReason,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

export function createMemoryRepository(seed?: Partial<MemoryDb>): ReviewRepository {
  const db: MemoryDb = { reviews: [], reports: [], ...seed };
  let nextReviewId = db.reviews.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  let nextReportId = db.reports.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  const byId = (id: number) => db.reviews.find((r) => r.id === id);

  return {
    async ping(): Promise<void> {},

    async listPublishedReviews(itemId, page, perPage) {
      const published = db.reviews
        .filter((r) => r.itemId === itemId && r.status === "published")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return {
        items: published.slice((page - 1) * perPage, page * perPage).map(clone),
        total: published.length,
      };
    },

    async getSummary(itemId) {
      const published = db.reviews.filter(
        (r) => r.itemId === itemId && r.status === "published",
      );
      return {
        reviewCount: published.length,
        ratingSum: published.reduce((s, r) => s + r.rating, 0),
      };
    },

    async findReviewByAuthor(itemId, authorHashHex) {
      const row = db.reviews.find(
        (r) => r.itemId === itemId && r.authorHash === authorHashHex,
      );
      return row ? clone(row) : null;
    },

    async upsertReview(input) {
      const existing = db.reviews.find(
        (r) =>
          r.itemId === input.itemId && r.authorHash === input.authorHashHex,
      );
      const now = new Date();
      if (existing) {
        existing.rating = input.rating;
        existing.body = input.body;
        existing.updatedAt = now;
        return { review: clone(existing), created: false };
      }
      const row: Row = {
        id: nextReviewId++,
        itemId: input.itemId,
        authorHash: input.authorHashHex,
        rating: input.rating,
        body: input.body,
        status: "published",
        hiddenReason: null,
        createdAt: now,
        updatedAt: now,
      };
      db.reviews.push(row);
      return { review: clone(row), created: true };
    },

    async getReview(id) {
      const row = byId(id);
      return row ? clone(row) : null;
    },

    async updateOwnReview(id, authorHashHex, patch) {
      const row = byId(id);
      if (!row) return { found: false, owned: false, review: null };
      if (row.authorHash !== authorHashHex) {
        return { found: true, owned: false, review: null };
      }
      if (patch.rating !== undefined) row.rating = patch.rating;
      if (patch.body !== undefined) row.body = patch.body;
      row.updatedAt = new Date();
      return { found: true, owned: true, review: clone(row) };
    },

    async deleteOwnReview(id, authorHashHex) {
      const row = byId(id);
      if (!row) return { found: false, owned: false };
      if (row.authorHash !== authorHashHex) return { found: true, owned: false };
      row.status = "deleted";
      row.updatedAt = new Date();
      return { found: true, owned: true };
    },

    async addReport(reviewId, reporterHashHex) {
      const dup = db.reports.find(
        (r) => r.reviewId === reviewId && r.reporterHash === reporterHashHex,
      );
      if (dup) return { added: false };
      db.reports.push({
        id: nextReportId++,
        reviewId,
        reporterHash: reporterHashHex,
        createdAt: new Date(),
      });
      return { added: true };
    },

    async countReports(reviewId) {
      return db.reports.filter((r) => r.reviewId === reviewId).length;
    },

    async setStatus(reviewId, status, hiddenReason) {
      const row = byId(reviewId);
      if (!row) return false;
      row.status = status;
      row.hiddenReason = hiddenReason;
      row.updatedAt = new Date();
      return true;
    },

    async adminListReviews({ status, itemId, page, perPage }) {
      const filtered = db.reviews
        .filter(
          (r) =>
            (status === undefined || r.status === status) &&
            (itemId === undefined || r.itemId === itemId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return {
        items: filtered
          .slice((page - 1) * perPage, page * perPage)
          .map((r) => ({
            ...clone(r),
            reportCount: db.reports.filter((rep) => rep.reviewId === r.id).length,
          })),
        total: filtered.length,
      };
    },
  };
}
