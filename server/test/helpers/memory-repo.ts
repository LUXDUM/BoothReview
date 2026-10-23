import type {
  AuthorBlockRecord,
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
  shop: string | null;
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
  blocks: Array<{ authorHash: string; reason: string | null; createdAt: Date }>;
};

function clone(r: Row): ReviewRecord {
  return {
    id: r.id,
    itemId: r.itemId,
    authorHash: r.authorHash,
    rating: r.rating,
    body: r.body,
    status: r.status,
    hiddenReason: r.hiddenReason,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}
export function createMemoryRepository(seed?: Partial<MemoryDb>): ReviewRepository {
  const db: MemoryDb = { reviews: [], reports: [], blocks: [], ...seed };
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

    async listSummaries(itemIds) {
      return itemIds.slice(0, 50).map((id) => {
        const published = db.reviews.filter((r) => r.itemId === id && r.status === "published");
        return {
          itemId: id,
          reviewCount: published.length,
          ratingSum: published.reduce((s, r) => s + r.rating, 0),
        };
      });
    },

    async getShopSummary(shop) {
      const published = db.reviews.filter(
        (r) => r.shop === shop && r.status === "published",
      );
      return {
        reviewCount: published.length,
        ratingSum: published.reduce((s, r) => s + r.rating, 0),
      };
    },

    async listShopReviews(shop, page, perPage) {
      const published = db.reviews
        .filter((r) => r.shop === shop && r.status === "published")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return {
        items: published.slice((page - 1) * perPage, page * perPage).map(clone),
        total: published.length,
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
        // ユーザー自身の削除からの再投稿は「新規投稿」として復活 (hidden は復活させない)
        if (existing.status === "deleted") {
          existing.status = "published";
          existing.hiddenReason = null;
        }
        existing.rating = input.rating;
        existing.body = input.body;
        if (input.shop !== undefined) existing.shop = input.shop;
        existing.updatedAt = now;
        return { review: clone(existing), created: false };
      }
      const row: Row = {
        id: nextReviewId++,
        itemId: input.itemId,
        shop: input.shop ?? null,
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
      if (patch.shop !== undefined) row.shop = patch.shop;
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

    async adminListReviews({ status, itemId, query, authorHashHex, order, page, perPage }) {
      const filtered = db.reviews
        .filter(
          (r) =>
            (status === undefined || r.status === status) &&
            (itemId === undefined || r.itemId === itemId) &&
            (query === undefined ||
              query === "" ||
              r.body.toLowerCase().includes(query.toLowerCase())) &&
            (authorHashHex === undefined || r.authorHash === authorHashHex),
        )
        .sort((a, b) => {
          if (order === "reports") {
            return (
              db.reports.filter((rep) => rep.reviewId === b.id).length -
                db.reports.filter((rep) => rep.reviewId === a.id).length ||
              b.id - a.id
            );
          }
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
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

    async adminStats() {
      const counts = { total: db.reviews.length, published: 0, hidden: 0, deleted: 0 };
      for (const r of db.reviews) counts[r.status] += 1;

      const published = db.reviews.filter((r) => r.status === "published");
      const ratingDistribution = [0, 0, 0, 0, 0];
      let ratingSum = 0;
      for (const r of published) {
        ratingDistribution[r.rating - 1] += 1;
        ratingSum += r.rating;
      }
      const avgRating = published.length > 0 ? ratingSum / published.length : null;

      const reportTotal = db.reports.length;
      const topReported = db.reviews
        .map((r) => ({
          ...clone(r),
          reportCount: db.reports.filter((rep) => rep.reviewId === r.id).length,
        }))
        .filter((r) => r.reportCount > 0)
        .sort((a, b) => b.reportCount - a.reportCount || b.id - a.id)
        .slice(0, 10);

      // 直近30日の日次投稿数 (ローカル日付の UTC 文字列でゼロ埋め)
      const trend: Array<{ day: string; count: number }> = [];
      const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
      const today = new Date();
      for (let i = 29; i >= 0; i--) {
        const day = new Date(today);
        day.setUTCDate(day.getUTCDate() - i);
        const key = dayKey(day);
        trend.push({ day: key, count: db.reviews.filter((r) => dayKey(r.createdAt) === key).length });
      }

      const byItem = new Map<number, number>();
      for (const r of published) byItem.set(r.itemId, (byItem.get(r.itemId) ?? 0) + 1);
      const topItems = [...byItem.entries()]
        .map(([itemId, count]) => ({ itemId, count }))
        .sort((a, b) => b.count - a.count || b.itemId - a.itemId)
        .slice(0, 10);

      // DB 実装の深揗ディスク容量はこちらでは取得できないため null 固定
      return {
        counts,
        avgRating,
        ratingDistribution,
        reportTotal,
        topReported,
        trend,
        topItems,
        dbSizeBytes: null,
        tableSizes: [],
      };
    },

    async listAuthorBlocks(): Promise<AuthorBlockRecord[]> {
      return db.blocks
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((b) => {
          const sample = db.reviews
            .filter((r) => r.authorHash === b.authorHash)
            .sort((a, b2) => a.id - b2.id)[0];
          return {
            authorHash: b.authorHash,
            reason: b.reason,
            createdAt: new Date(b.createdAt),
            sampleReviewId: sample ? sample.id : null,
          };
        });
    },

    async isAuthorBlocked(authorHashHex) {
      return db.blocks.some((b) => b.authorHash === authorHashHex);
    },

    async blockAuthor(authorHashHex, reason) {
      const existing = db.blocks.find((b) => b.authorHash === authorHashHex);
      if (existing) return false;
      db.blocks.push({ authorHash: authorHashHex, reason, createdAt: new Date() });
      return true;
    },

    async unblockAuthor(authorHashHex) {
      const before = db.blocks.length;
      db.blocks = db.blocks.filter((b) => b.authorHash !== authorHashHex);
      return db.blocks.length < before;
    },
  };
}
