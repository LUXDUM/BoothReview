import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { authorHash } from "../src/lib/hash.js";
import { silentLogger } from "./helpers/logger.js";

const A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";
const B = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";

let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: "unit-test-admin-token-0123456789",
    MIN_BODY_LEN: "10",
    REPORT_AUTOHIDE_THRESHOLD: "3",
    RATE_LIMIT_POST_PER_IP_PER_HOUR: "3",
    RATE_LIMIT_POST_PER_ANON_PER_HOUR: "2",
    RATE_LIMIT_LIST_PER_IP_PER_MINUTE: "50",
    RATE_LIMIT_MINE_PER_IP_PER_MINUTE: "5",
    RATE_LIMIT_REPORT_PER_IP_PER_HOUR: "20",
  });
  deps = {
    config,
    repo: createMemoryRepository(),
    limiter: createRateLimiter(),
    logger: silentLogger,
  };
  app = createApp(deps);
});

beforeEach(() => {
  // 各テストでレート制限をリセット
  deps.limiter.reset();
});

describe("POST /v1/items/:id/reviews", () => {
  it("creates a review and returns 201 without leaking any hash", async () => {
    const res = await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 4, body: "素晴らしい商品でした", anonId: A }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.created).toBe(true);
    expect(data.review).toEqual({
      id: expect.any(Number),
      rating: 4,
      body: "素晴らしい商品でした",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // レスポンスに暗号ハッシュや匿名IDが含まれないこと
    const json = JSON.stringify(data);
    expect(json).not.toContain(A);
    expect(json).not.toContain(authorHash("unit-test-pepper-0123456789", A));
  });

  it("updates when the same anon id posts again (created=false)", async () => {
    await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 3, body: "まあまあでした", anonId: A }),
    });
    const res = await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 5, body: "あらためて見たら良かった", anonId: A }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created).toBe(false);
    expect(data.review.rating).toBe(5);
    expect(data.review.body).toBe("あらためて見たら良かった");
  });

  it("rejects invalid rating and short body", async () => {
    const res1 = await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 6, body: "0123456789abc", anonId: A }),
    });
    expect(res1.status).toBe(400);
    const res2 = await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 3, body: "short", anonId: A }),
    });
    expect(res2.status).toBe(400);
  });

  it("rate-limits per anon id after the configured count", async () => {
    const post = () =>
      app.request("/v1/items/12345/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 3, body: "0123456789abc", anonId: A }),
      });
    await post(); // ok (per-anon 1/2)
    const second = await post(); // ok, per-anon 2/2 (同内容で更新)
    expect(second.status).toBe(200);
    const third = await post(); // per-anon 超過
    expect(third.status).toBe(429);
    expect(await third.text()).toContain("RATE_LIMITED");
  });

  it("returns unified error shape for validation failures", async () => {
    const res = await app.request("/v1/items/12345/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 3 }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(typeof data.error.message).toBe("string");
  });
});

describe("ownership: edit / delete", () => {
  let reviewId: number;

  beforeEach(async () => {
    deps.repo = createMemoryRepository();
    app = createApp(deps);
    const res = await app.request("/v1/items/99/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 5, body: "とても満足しています", anonId: A }),
    });
    const data = await res.json();
    reviewId = data.review.id;
  });

  it("PATCH by owner updates the review", async () => {
    const res = await app.request(`/v1/reviews/${reviewId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-anon-id": A },
      body: JSON.stringify({ rating: 2, body: "やはり気に入らない部分があった" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.review.rating).toBe(2);
  });

  it("PATCH by another anon id is forbidden (403)", async () => {
    const res = await app.request(`/v1/reviews/${reviewId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-anon-id": B },
      body: JSON.stringify({ rating: 1, body: "他人が勝手に書き換える", anonId: B }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("PATCH by unknown anon id is forbidden too", async () => {
    const res = await app.request(`/v1/reviews/${reviewId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-anon-id": B },
      body: JSON.stringify({ body: "他人のわけではないので失敗する" }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE by another anon id is forbidden (403)", async () => {
    const res = await app.request(`/v1/reviews/${reviewId}`, {
      method: "DELETE",
      headers: { "x-anon-id": B },
    });
    expect(res.status).toBe(403);
    // レビューは残っている
    const list = await app.request("/v1/items/99/reviews");
    const data = await list.json();
    expect(data.total).toBe(1);
  });

  it("DELETE by owner logically deletes the review", async () => {
    const res = await app.request(`/v1/reviews/${reviewId}`, {
      method: "DELETE",
      headers: { "x-anon-id": A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const list = await app.request("/v1/items/99/reviews");
    const data = await list.json();
    expect(data.total).toBe(0);
  });

  it("DELETE unknown id returns 404", async () => {
    const res = await app.request("/v1/reviews/999999", {
      method: "DELETE",
      headers: { "x-anon-id": A },
    });
    expect(res.status).toBe(404);
  });

  it("GET mine returns the owner's review and null for others", async () => {
    const mine = await app.request("/v1/items/99/mine", { headers: { "x-anon-id": A } });
    const mineData = await mine.json();
    expect(mineData.review.id).toBe(reviewId);
    const other = await app.request("/v1/items/99/mine", { headers: { "x-anon-id": B } });
    expect((await other.json()).review).toBeNull();
    // X-Anon-ID なし → 400
    const none = await app.request("/v1/items/99/mine");
    expect(none.status).toBe(400);
  });
});

describe("list / summary", () => {
  beforeEach(() => {
    deps.repo = createMemoryRepository();
    app = createApp(deps);
  });

  it("returns empty list and null average for unknown item", async () => {
    const res = await app.request("/v1/items/1/summary");
    expect(await res.json()).toEqual({ count: 0, average: null });
    const list = await app.request("/v1/items/1/reviews");
    const data = await list.json();
    expect(data.total).toBe(0);
    expect(data.reviews).toEqual([]);
  });

  it("excludes hidden/deleted reviews from list and summary", async () => {
    const ids = await Promise.all(
      ["A", "B", "C"].map(async (i) => {
        const res = await app.request("/v1/items/7/reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            rating: i === "A" ? 5 : i === "B" ? 1 : 4,
            body: `review-${i}-0123456789`,
            anonId:
              i === "A"
                ? "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d"
                : i === "B"
                  ? "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
                  : "73475cb4-140a-48c8-b6e9-d0b76a9bb07e",
          }),
        });
        return (await res.json()).review.id as number;
      }),
    );
    await app.request(`/v1/admin/reviews/${ids[0]}`, {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    const summary = await (await app.request("/v1/items/7/summary")).json();
    // 非表示になった分は集計から外れる
    expect(summary.count).toBe(2);
    const list = await (await app.request("/v1/items/7/reviews")).json();
    expect(list.total).toBe(2);
    expect(list.totalPages).toBeGreaterThanOrEqual(1);
  });

  it("supports ETag / If-None-Match 304", async () => {
    await app.request("/v1/items/8/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 4, body: "0123456789abcdef", anonId: A }),
    });
    const first = await app.request("/v1/items/8/reviews");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("max-age=");
    const second = await app.request("/v1/items/8/reviews", {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    const notMatch = await app.request("/v1/items/8/reviews", {
      headers: { "if-none-match": '"deadbeef"' },
    });
    expect(notMatch.status).toBe(200);
  });
});

describe("reports", () => {
  beforeEach(() => {
    deps.repo = createMemoryRepository();
    app = createApp(deps);
  });

  const makeReview = async () => {
    const res = await app.request("/v1/items/55/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 1, body: "まともな商品ではなかった", anonId: B }),
    });
    return (await res.json()).review.id as number;
  };

  it("auto-hides after threshold reports", async () => {
    const id = await makeReview();
    const reporters = [A, "73475cb4-140a-48c8-b6e9-d0b76a9bb07e", "b17b6f5f-4e93-4a27-9f0a-7a1f4c3c8b90"];
    for (const anonId of reporters) {
      const res = await app.request(`/v1/reviews/${id}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anonId }),
      });
      expect(res.status).toBe(200);
    }
    // 閾値 (3) 到達で自動非表示
    const list = await (await app.request("/v1/items/55/reviews")).json();
    expect(list.total).toBe(0);
  });

  it("rejects duplicate report from the same anon id", async () => {
    const id = await makeReview();
    const res1 = await app.request(`/v1/reviews/${id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId: A }),
    });
    expect(res1.status).toBe(200);
    const res2 = await app.request(`/v1/reviews/${id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId: A }),
    });
    expect(res2.status).toBe(409);
    expect((await res2.json()).error.code).toBe("ALREADY_REPORTED");
  });

  it("returns 404 for unknown review", async () => {
    const res = await app.request("/v1/reviews/424242/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId: A }),
    });
    expect(res.status).toBe(404);
  });
});

describe("admin API", () => {
  beforeEach(() => {
    deps.repo = createMemoryRepository();
    app = createApp(deps);
  });

  it("requires admin token", async () => {
    const res = await app.request("/v1/admin/reviews");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("lists reviews with report counts and can hide/restore/delete", async () => {
    const create = await app.request("/v1/items/31/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 2, body: "少し気になる点があった", anonId: A }),
    });
    const id = (await create.json()).review.id as number;

    const list = await app.request("/v1/admin/reviews?status=published", {
      headers: { authorization: "Bearer unit-test-admin-token-0123456789" },
    });
    const listData = await list.json();
    expect(list.status).toBe(200);
    expect(listData.total).toBeGreaterThanOrEqual(1);
    expect(listData.reviews[0].reportCount).toBe(0);

    const hide = await app.request(`/v1/admin/reviews/${id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(hide.status).toBe(200);
    expect((await hide.json()).review.hiddenReason).toBe("admin");

    const restore = await app.request(`/v1/admin/reviews/${id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });
    expect((await restore.json()).review.status).toBe("published");

    const del = await app.request(`/v1/admin/reviews/${id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect((await del.json()).review.status).toBe("deleted");
  });

  it("rejects unknown status value", async () => {
    const create = await app.request("/v1/items/31/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: 2, body: "0123456789xyzw", anonId: A }),
    });
    const id = (await create.json()).review.id as number;
    const res = await app.request(`/v1/admin/reviews/${id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ status: "mystery" }),
    });
    expect(res.status).toBe(400);
  });
});
