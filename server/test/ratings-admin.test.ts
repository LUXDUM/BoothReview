import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { authorHash } from "../src/lib/hash.js";
import { silentLogger } from "./helpers/logger.js";

const A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";
const B = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
const ADMIN = "unit-test-admin-token-0123456789";

let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: ADMIN,
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

async function post(item: number, rating: number, body: string, anonId: string): Promise<Response> {
  return app.request(`/v1/items/${item}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating, body, anonId }),
  });
}

describe("一括評価 API (GET /v1/items/ratings)", () => {
  it("複数 item の評価を伴って返す", async () => {
    await post(8711621, 5, "一括評価テストです！", A);
    await post(8711621, 3, "もう一件のレビューです", B);
    await post(9311621, 4, "別の商品のレビューです", A);

    const res = await app.request("/v1/items/ratings?ids=8711621,9311621,9999999");
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ratings: Record<string, { count: number; average: number | null }> };
    expect(d.ratings["8711621"]).toEqual({ count: 2, average: 4 });
    expect(d.ratings["9311621"]).toEqual({ count: 1, average: 4 });
    // DB に存在しない商品は伴数として返ってこない (フロント側で無視)
    expect(d.ratings["9999999"]).toBeUndefined();
  });

  it("ids 無しは 400 / 空は 400 / 51件以上は先頭50件まで", async () => {
    expect((await app.request("/v1/items/ratings")).status).toBe(400);
    expect((await app.request("/v1/items/ratings?ids=")).status).toBe(400);
    // 51件 → 400 ではなく 50件に丸める (重複除)
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1)).join(",");
    const res = await app.request(`/v1/items/ratings?ids=${ids}`);
    expect(res.status).toBe(200);
  });
});

describe("公開レビューの匿名ID短縮ハッシュ", () => {
  it("『author』で短縮ハッシュ (8文字) を返す / UUIDは返さない", async () => {
    const res = await app.request("/v1/items/8711621/reviews");
    const d = (await res.json()) as { reviews: Array<{ author: string }> };
    expect(d.reviews[0].author).toMatch(/^[0-9a-f]{8}$/);
    const body = JSON.stringify(d);
    expect(body).not.toContain(A);
  });
});

describe("管理画面の匿名ID検索 + 削除", () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("anonId (生UUID) でレビューを検索できる", async () => {
    const res = await app.request(`/v1/admin/reviews?anonId=${A}`, { headers: auth });
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      reviews: Array<{ id: number; author: string; status: string }>;
    };
    // 匿名A のレビューのみ (8711621 * 1件 + 9311621 * 1件)
    expect(d.reviews.length).toBe(2);
    expect(d.reviews.every((r) => r.author === authorHash("unit-test-pepper-0123456789", A).slice(0, 8))).toBe(true);
  });

  it("不正な anonId は 400", async () => {
    const res = await app.request("/v1/admin/reviews?anonId=not-a-uuid", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("管理PATCH (status: deleted) で削除でき、公開側から消える", async () => {
    // 匿名B のレビュー (id 2) を削除
    const res = await app.request("/v1/admin/reviews/2", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(res.status).toBe(200);
    const list = await app.request("/v1/items/8711621/reviews");
    const d = (await list.json()) as { reviews: Array<{ id: number }>; total: number };
    expect(d.total).toBe(1);
    expect(d.reviews[0].id).not.toBe(2);
  });
});
