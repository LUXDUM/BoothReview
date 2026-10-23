import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import {
  MAX_URLS,
  REPOST_WINDOW_MS,
  assertBodyAllowed,
  bodyKey,
  createRepostGuard,
} from "../src/lib/moderation.js";
import { AppError, Errors } from "../src/lib/errors.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { silentLogger } from "./helpers/logger.js";

const A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";
const B = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const D = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const ADMIN = "unit-test-admin-token-0123456789";

describe("moderation: assertBodyAllowed", () => {
  it("allows bodies without URLs", () => {
    expect(() => assertBodyAllowed("最高の商品でした")).not.toThrow();
  });

  it(`allows up to ${MAX_URLS} URL`, () => {
    expect(() => assertBodyAllowed("こちらもどうぞ https://example.com/x")).not.toThrow();
  });

  it("rejects bodies with more than one URL", () => {
    expect(() =>
      assertBodyAllowed("https://a.example.com と https://b.example.com"),
    ).toThrow(AppError);
    try {
      assertBodyAllowed("http://a.example.com http://b.example.com");
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe("VALIDATION_ERROR");
      expect((e as AppError).status).toBe(400);
    }
  });

  it("counts www. style URLs too", () => {
    expect(() => assertBodyAllowed("www.example.com www.example.org")).toThrow(AppError);
  });
});

describe("moderation: bodyKey normalization", () => {
  it("treats whitespace-only differences as the same body", () => {
    expect(bodyKey("いいね!  最高。\n\n最高。")).toBe(bodyKey("いいね! 最高。 最高。"));
  });
});

describe("moderation: RepostGuard", () => {
  it("blocks the same body by the same author within the window", () => {
    let t = 0;
    const guard = createRepostGuard(() => t);
    guard.record("hash-a", "同じ本文");
    expect(() => guard.assertNotRepost("hash-a", "同じ本文")).toThrow(
      (Errors.conflict() as AppError).constructor,
    );
    try {
      guard.assertNotRepost("hash-a", "同じ本文");
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe("CONFLICT");
      expect((e as AppError).status).toBe(409);
    }
  });

  it("allows different bodies and different authors", () => {
    let t = 0;
    const guard = createRepostGuard(() => t);
    guard.record("hash-a", "本文1");
    guard.record("hash-b", "本文1");
    expect(() => guard.assertNotRepost("hash-a", "本文2")).not.toThrow();
    expect(() => guard.assertNotRepost("hash-c", "本文1")).not.toThrow();
  });

  it(`allows the same body again after ${REPOST_WINDOW_MS} ms`, () => {
    let t = 0;
    const guard = createRepostGuard(() => t);
    guard.record("hash-a", "同じ本文");
    t = REPOST_WINDOW_MS + 1;
    expect(() => guard.assertNotRepost("hash-a", "同じ本文")).not.toThrow();
  });

  it("prunes old records to bound memory", () => {
    let t = 0;
    const guard = createRepostGuard(() => t);
    guard.record("hash-a", "old body");
    t = REPOST_WINDOW_MS + 1;
    guard.record("hash-a", "new body");
    t = 0; // 戻しても消えた記録は戻らない
    expect(() => guard.assertNotRepost("hash-a", "old body")).not.toThrow();
  });
});

// --- ルート層 (BAN・バーストレート・連投稿判) ---

type App = ReturnType<typeof createApp>;
// ルート層で DI する RepostGuard。clockMs を進めて時間経過を再現する
let clockMs = 0;
const guard = createRepostGuard(() => clockMs);

function makeApp(rateOverrides: Record<string, string> = {}): {
  app: App;
  repo: ReturnType<typeof createMemoryRepository>;
  limiter: ReturnType<typeof createRateLimiter>;
} {
  const repo = createMemoryRepository();
  const limiter = createRateLimiter();
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: ADMIN,
    MIN_BODY_LEN: "10",
    REPORT_AUTOHIDE_THRESHOLD: "3",
    RATE_LIMIT_POST_PER_IP_PER_HOUR: "100",
    RATE_LIMIT_POST_PER_ANON_PER_HOUR: "100",
    RATE_LIMIT_POST_PER_IP_PER_5MIN: "2",
    RATE_LIMIT_LIST_PER_IP_PER_MINUTE: "50",
    RATE_LIMIT_REPORT_PER_IP_PER_HOUR: "100",
    ...rateOverrides,
  });
  const deps: AppDeps = {
    config,
    repo,
    limiter,
    logger: silentLogger,
    repostGuard: guard,
  };
  return { app: createApp(deps), repo, limiter };
}

function postReview(app: App, itemId: number, body: string, anonId = A) {
  return app.request(`/v1/items/${itemId}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating: 5, body, anonId }),
  });
}

describe("routes: author ban", () => {
  let app: App;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeAll(() => {
    ({ app, limiter } = makeApp());
  });

  beforeEach(() => {
    clockMs = 0;
    guard.reset();
    limiter.reset();
  });

  it("admin can ban and unban an author via a review id, without leaking the full hash", async () => {
    const created = await postReview(app, 100, "まずまずの商品でした");
    expect(created.status).toBe(201);
    const review = (await created.json()) as { review: { id: number } };

    // BAN 登録 (冪等に2回呼んでもよい)
    const ban = await app.request("/v1/admin/blocks", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ reviewId: review.review.id }),
    });
    expect(ban.status).toBe(200);
    const banData = (await ban.json()) as {
      created: boolean;
      block: { author: string; reviewId: number };
    };
    expect(banData.created).toBe(true);
    expect(banData.block.author).toMatch(/^[0-9a-f]{8}$/);
    expect(banData.block.reviewId).toBe(review.review.id);

    // 一覧にもフルハッシュは出ない
    const list = await app.request("/v1/admin/blocks", {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const listData = (await list.json()) as {
      total: number;
      blocks: Array<{ author: string; sampleReviewId: number; reason: string }>;
    };
    expect(listData.total).toBe(1);
    expect(listData.blocks[0].author).toMatch(/^[0-9a-f]{8}$/);
    expect(listData.blocks[0].sampleReviewId).toBe(review.review.id);
    expect(listData.blocks[0].reason).toBe(`review:${review.review.id}`);

    // 解除
    const unban = await app.request(`/v1/admin/blocks/${review.review.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(unban.status).toBe(200);
    const unbanData = (await unban.json()) as { removed: boolean };
    expect(unbanData.removed).toBe(true);

    // 2回目の解除は removed=false
    const again = await app.request(`/v1/admin/blocks/${review.review.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const againData = (await again.json()) as { removed: boolean };
    expect(againData.removed).toBe(false);
  });

  it("a blocked author cannot post, edit or report, but can still delete", async () => {
    const created = await postReview(app, 200, "とても良い仕上げです");
    const review = (await created.json()) as { review: { id: number } };
    await app.request("/v1/admin/blocks", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ reviewId: review.review.id }),
    });

    // 新規投稿 → 403
    const repost = await postReview(app, 201, "別の商品への投稿です");
    expect(repost.status).toBe(403);
    const repostData = (await repost.json()) as { error: { code: string } };
    expect(repostData.error.code).toBe("FORBIDDEN");

    // 編集 → 403
    const patch = await app.request(`/v1/reviews/${review.review.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-anon-id": A },
      body: JSON.stringify({ rating: 3 }),
    });
    expect(patch.status).toBe(403);

    // 通報 → 403 (BAN者の通報で自動hiddenに影響させない)
    const other = await postReview(app, 300, "別の人のレビューです", B);
    const otherReview = (await other.json()) as { review: { id: number } };
    const report = await app.request(`/v1/reviews/${otherReview.review.id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId: A }),
    });
    expect(report.status).toBe(403);

    // 自分のレビューの削除は許可 (セルフクリーンアップ)
    const del = await app.request(`/v1/reviews/${review.review.id}`, {
      method: "DELETE",
      headers: { "x-anon-id": A },
    });
    expect(del.status).toBe(200);
  });

  it("unbanned author can post again", async () => {
    // 別の匿名ID D で検証 (A は前のテストでBANされたままのため)
    const created = await postReview(app, 400, "公平なレビューを書きました", D);
    const review = (await created.json()) as { review: { id: number } };
    expect(created.status).toBe(201);
    await app.request("/v1/admin/blocks", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ reviewId: review.review.id }),
    });
    expect((await postReview(app, 401, "再投稿を試みる本文です", D)).status).toBe(403);

    await app.request(`/v1/admin/blocks/${review.review.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const after = await postReview(app, 401, "再投稿を試みる本文です", D);
    // item 401 は BAN 中に作成失敗しているため、解除後は新規投稿 (201) になる
    expect(after.status).toBe(201);
    const data = (await after.json()) as { created: boolean };
    expect(data.created).toBe(true);
  });
});

describe("routes: spam filters", () => {
  let app: App;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeAll(() => {
    // バーストは別テストで検証するため、ここでは緩めておく
    ({ app, limiter } = makeApp({ RATE_LIMIT_POST_PER_IP_PER_5MIN: "50" }));
  });

  beforeEach(() => {
    clockMs = 0;
    guard.reset();
    limiter.reset();
  });

  it("rejects a new post containing two URLs with 400", async () => {
    const res = await postReview(app, 500, "https://a.example.com と www.b.example.com です");
    expect(res.status).toBe(400);
  });

  it("blocks the same body cross-posted to another item within the window", async () => {
    const first = await postReview(app, 510, "コピペの連投レビューですよ");
    expect(first.status).toBe(201);
    const second = await postReview(app, 511, "コピペの連投レビューですよ");
    expect(second.status).toBe(409);
    const data = (await second.json()) as { error: { code: string } };
    expect(data.error.code).toBe("CONFLICT");

    // 別の本文なら OK (バースト制限は 2/5分なので 1件目のみで検証は終了)
    const third = await postReview(app, 512, "まったく別の本文テキスト");
    expect(third.status).toBe(201);
  });

  it("does not treat rewriting your own review as a repost", async () => {
    const first = await postReview(app, 520, "じぶんのレビューを書き直します");
    expect(first.status).toBe(201);
    // 同一 (item, author) への再投稿 = 更新経路。連投判定もバースト制限も適用されない
    const again = await postReview(app, 520, "じぶんのレビューを書き直します");
    expect(again.status).toBe(200);
    const data = (await again.json()) as { created: boolean };
    expect(data.created).toBe(false);
  });
});

describe("routes: burst rate (5 minutes)", () => {
  let app: App;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeAll(() => {
    ({ app, limiter } = makeApp());
  });

  beforeEach(() => {
    clockMs = 0;
    guard.reset();
    limiter.reset();
  });

  it("allows 2 new posts per IP per 5 minutes, then 429", async () => {
    const res1 = await postReview(app, 600, "一本目の投稿テキストです");
    expect(res1.status).toBe(201);
    const res2 = await postReview(app, 601, "二本目の投稿テキストです");
    expect(res2.status).toBe(201);
    const res3 = await postReview(app, 602, "三本目の投稿テキストです");
    expect(res3.status).toBe(429);
    const data = (await res3.json()) as { error: { code: string } };
    expect(data.error.code).toBe("RATE_LIMITED");
  });

  it("still applies the hourly limit for new posts", async () => {
    const { app: app2 } = makeApp({
      RATE_LIMIT_POST_PER_IP_PER_5MIN: "50",
      RATE_LIMIT_POST_PER_IP_PER_HOUR: "2",
    });
    await postReview(app2, 610, "一時的な投稿テキストです");
    await postReview(app2, 611, "二時限目の投稿テキストです");
    const res3 = await postReview(app2, 612, "しかと三番目のテキストです");
    expect(res3.status).toBe(429);
  });
});
