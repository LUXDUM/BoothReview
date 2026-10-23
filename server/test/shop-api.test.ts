import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { silentLogger } from "./helpers/logger.js";

const A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";
const B = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const C = "7d444840-9dc0-11d1-b245-5ffdce74fad2";

let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: "unit-test-admin-token-0123456789",
    MIN_BODY_LEN: "10",
    RATE_LIMIT_POST_PER_IP_PER_5MIN: "50",
  });
  const repo = createMemoryRepository();
  deps = { config, repo, limiter: createRateLimiter(), logger: silentLogger };
  app = createApp(deps);
});

beforeEach(() => {
  deps.limiter.reset();
});

type PostBody = { rating: number; body: string; anonId: string; shop?: string };

function post(itemId: number, body: PostBody): Promise<Response> {
  return app.request(`/v1/items/${itemId}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ショップ集計 API", () => {
  it("投稿時に shop を記録でき、ショップ summary に反映される", async () => {
    // shopA: item100 に2件 (★5, ★3) / shopB: item200 に1件 (★4)
    // shop 未指定 (旧データ想定): item300 に1件 (★1)
    expect((await post(100, { rating: 5, body: "shopAのとても良い商品", anonId: A, shop: "shopa" })).status).toBe(201);
    expect((await post(100, { rating: 3, body: "shopAのまあまあの商品", anonId: B, shop: "shopa" })).status).toBe(201);
    expect((await post(200, { rating: 4, body: "shopBの良い商品です", anonId: A, shop: "shopb" })).status).toBe(201);
    expect((await post(300, { rating: 1, body: "ショップ未記録のレビュー", anonId: B })).status).toBe(201);

    const res = await app.request("/v1/shops/shopa/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2, average: 4 });

    const resB = await app.request("/v1/shops/shopb/summary");
    expect(await resB.json()).toEqual({ count: 1, average: 4 });

    // 紐付けなしレビューはどのショップにも含まれない
    const resX = await app.request("/v1/shops/shopx/summary");
    expect(await resX.json()).toEqual({ count: 0, average: null });
  });

  it("ショップのレビュー一覧は itemId 付きでページングされる", async () => {
    const res = await app.request("/v1/shops/shopa/reviews");
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      reviews: Array<{ id: number; itemId: number; rating: number; body: string }>;
      total: number;
      totalPages: number;
    };
    expect(d.total).toBe(2);
    expect(d.reviews.map((r) => r.itemId)).toEqual([100, 100]);
    expect(d.reviews[0].rating).toBe(3); // 新しい順 → 後から投稿した★3が先頭
    expect(d.reviews[0].body).toContain("shopA");
  });

  it("他ショップのレビューは一覧に混ざらない", async () => {
    const res = await app.request("/v1/shops/shopb/reviews");
    const d = (await res.json()) as { reviews: Array<{ itemId: number }>; total: number };
    expect(d.total).toBe(1);
    expect(d.reviews[0].itemId).toBe(200);
  });

  it("ショップサブドメインの形式検査", async () => {
    const res = await app.request("/v1/shops/Bad_Shop/reviews");
    expect(res.status).toBe(400);
  });

  it("編集 (PATCH) でショップ紐付けを追加できる", async () => {
    // item300 の shop 無しレビュー (id 4) を PATCH で shopa に紐付ける
    const res = await app.request("/v1/reviews/4", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-anon-id": B },
      body: JSON.stringify({ shop: "shopa" }),
    });
    expect(res.status).toBe(200);
    const after = await app.request("/v1/shops/shopa/summary");
    expect(await after.json()).toEqual({ count: 3, average: 3 }); // (5+3+1)/3

    const list = await app.request("/v1/shops/shopa/reviews?page=3&perPage=1");
    const d = (await list.json()) as { total: number };
    expect(d.total).toBe(3);
  });

  it("shop を指定せず再投稿しても既存の紐付けは消えない", async () => {
    const res = await post(300, { rating: 2, body: "ショップ未指定で更新したレビュー", anonId: B });
    expect(res.status).toBe(200);
    const after = await app.request("/v1/shops/shopa/summary");
    expect(await after.json()).toEqual({ count: 3, average: 3.33 }); // ★が1→2に変わる
    const mine = await app.request("/v1/items/300/mine", { headers: { "x-anon-id": B } });
    const d = (await mine.json()) as { review: { rating: number } | null };
    expect(d.review?.rating).toBe(2);
  });

  it("商品ページ側の一覧・集計は shop の影響を受けない", async () => {
    // item100 の商品単位集計は shopa 分のみ (item200/300 は別 item)
    const res = await app.request("/v1/items/100/summary");
    expect(await res.json()).toEqual({ count: 2, average: 4 });
  });
});

describe("匿名ID別のショップ一覧", () => {
  it("同一商品に匿名ID C の別レビューを投稿でき、ショップ一覧 total に含まれる", async () => {
    expect((await post(100, { rating: 4, body: "匿名Cからのレビューですよ", anonId: C, shop: "shopa" })).status).toBe(201);
    const res = await app.request("/v1/shops/shopa/reviews?perPage=2&page=2");
    const d = (await res.json()) as { reviews: Array<{ itemId: number }>; total: number };
    expect(d.total).toBe(4);
  });
});
