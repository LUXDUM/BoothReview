import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { authorHash } from "../src/lib/hash.js";
import { silentLogger } from "./helpers/logger.js";

const ANON_A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";
const ANON_B = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const TOKEN = "unit-test-admin-token-0123456789";

let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: TOKEN,
    MIN_BODY_LEN: "10",
    RATE_LIMIT_POST_PER_IP_PER_5MIN: "50",
  });
  const repo = createMemoryRepository();
  deps = { config, repo, limiter: createRateLimiter(), logger: silentLogger };
  app = createApp(deps);

  // --- seed ---
  // item100: ★5 公開 (通報2) / ★3 公開
  // item200: ★4 非表示 (通報1) / ★2 削除
  await repo.upsertReview({ itemId: 100, authorHashHex: authorHash(config.pepper, ANON_A), rating: 5, body: "最高の名刺です!" });
  await repo.upsertReview({ itemId: 100, authorHashHex: authorHash(config.pepper, ANON_B), rating: 3, body: "まあまあです。" });
  await repo.upsertReview({ itemId: 200, authorHashHex: authorHash(config.pepper, ANON_A), rating: 4, body: "良い商品でした。" });
  const r1 = await repo.upsertReview({ itemId: 200, authorHashHex: authorHash(config.pepper, ANON_B), rating: 2, body: "期待ほどでは…" });
  await repo.addReport(1, authorHash(config.pepper, ANON_B));
  await repo.addReport(1, authorHash(config.pepper, ANON_A));
  await repo.addReport(3, authorHash(config.pepper, ANON_B));
  await repo.setStatus(3, "hidden", "auto_report");
  await repo.deleteOwnReview(r1.review.id, authorHash(config.pepper, ANON_B));
});

beforeEach(() => {
  deps.limiter.reset();
});

describe("GET /v1/admin/stats", () => {
  it("トークンなしは 401", async () => {
    const res = await app.request("/v1/admin/stats");
    expect(res.status).toBe(401);
  });

  it("全体統計を返す", async () => {
    const res = await app.request("/v1/admin/stats", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d.counts).toEqual({ total: 4, published: 2, hidden: 1, deleted: 1 });
    // 平均は公開レビュー (★5 + ★3) のみ → 4.0
    expect(d.avgRating).toBeCloseTo(4, 5);
    // 分布 index0 = ★1 ... index4 = ★5 → ★1:0 ★2:0 ★3:1 ★4:0 ★5:1
    expect(d.ratingDistribution).toEqual([0, 0, 1, 0, 1]);
    expect(d.reportTotal).toBe(3);
    // 直近30日分、0埋めで必ず 30 要素
    expect((d.trend as unknown[]).length).toBe(30);
    // ディスク/バックアップ情報は無くても null / 空配列でレポートが壊れない
    expect(d.backups).toEqual([]);
  });

  it("通報ランキングは通報数の降順", async () => {
    const res = await app.request("/v1/admin/stats", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const d = (await res.json()) as { topReported: Array<{ id: number; reportCount: number }> };
    expect(d.topReported.length).toBe(2);
    expect(d.topReported[0]).toMatchObject({ id: 1, reportCount: 2 });
    expect(d.topReported[1]).toMatchObject({ id: 3, reportCount: 1 });
  });

  it("公開レビューの多いアイテム TOP", async () => {
    const res = await app.request("/v1/admin/stats", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const d = (await res.json()) as { topItems: Array<{ itemId: number; count: number }> };
    expect(d.topItems).toEqual([{ itemId: 100, count: 2 }]);
  });
});

describe("GET /v1/admin/reviews (検索・並び替え)", () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("query で本文部分一致", async () => {
    const res = await app.request("/v1/admin/reviews?query=%E6%9C%80%E9%AB%98", { headers: auth });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { total: number; reviews: Array<{ id: number }> };
    expect(d.total).toBe(1);
    expect(d.reviews[0].id).toBe(1);
  });

  it("order=reports で通報数の多い順", async () => {
    const res = await app.request("/v1/admin/reviews?order=reports", { headers: auth });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { reviews: Array<{ id: number; reportCount: number }> };
    expect(d.reviews[0]).toMatchObject({ id: 1, reportCount: 2 });
  });

  it("不正な order は 400", async () => {
    const res = await app.request("/v1/admin/reviews?order=bad", { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/dashboard", () => {
  it("HTMLシェルを返す (公開。データは含まない)", async () => {
    const res = await app.request("/admin/dashboard");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("BOOTHReview 管理ダッシュボード");
    expect(body).not.toContain("adminToken");
  });
});
