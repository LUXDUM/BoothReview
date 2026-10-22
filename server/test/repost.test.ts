import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { silentLogger } from "./helpers/logger.js";

const A = "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d";

let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: "unit-test-admin-token-0123456789",
    MIN_BODY_LEN: "10",
  });
  const repo = createMemoryRepository();
  deps = { config, repo, limiter: createRateLimiter(), logger: silentLogger };
  app = createApp(deps);
});

beforeEach(() => {
  deps.limiter.reset();
});

async function post(item: number, rating: number, body: string): Promise<Response> {
  return app.request(`/v1/items/${item}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating, body, anonId: A }),
  });
}

describe("削除からの再投稿", () => {
  it("削除 → 再投稿でレビューが公開状態に復活する (編集判定で消えない)", async () => {
    expect((await post(100, 4, "最初のレビューです！！！")).status).toBe(201);
    // 削除
    let mine = await app.request("/v1/items/100/mine", { headers: { "x-anon-id": A } });
    let id = ((await mine.json()) as { review: { id: number } }).review?.id;
    expect(id).toBeTruthy();
    expect((await app.request(`/v1/reviews/${id}`, { method: "DELETE", headers: { "x-anon-id": A } })).status).toBe(200);

    // 削除後は mine が null (= 新規投稿できる状態)
    mine = await app.request("/v1/items/100/mine", { headers: { "x-anon-id": A } });
    expect(((await mine.json()) as { review: unknown }).review).toBeNull();

    // 再投稿: 削除済み行と同一 (item, anon) だが新規投稿として公開に戻る
    const res = await post(100, 5, "削除からの再投稿です！！");
    expect(res.status).toBe(200);
    const posted = (await res.json()) as { review: { id: number; status?: string } };
    expect(posted.review.id).toBe(id);

    // 一覧に表示され、mine も戻る
    const list = await app.request("/v1/items/100/reviews");
    const d = (await list.json()) as { reviews: Array<{ id: number; rating: number }>; total: number };
    expect(d.total).toBe(1);
    expect(d.reviews[0]).toMatchObject({ id, rating: 5 });
  });

  it("管理者や通報で hidden にされたレビューは再投稿で復活しない", async () => {
    expect((await post(200, 4, "通報対象のレビューです")).status).toBe(201);
    // 管理操作で hidden 化
    const admin = app.request("/v1/admin/reviews/2", {
      method: "PATCH",
      headers: { authorization: "Bearer unit-test-admin-token-0123456789" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect((await admin).status).toBe(200);

    // 再投稿しても復活しない (一覧には出ない)
    const res = await post(200, 5, "再投稿してみるけど非表示のまま！！");
    expect(res.status).toBe(200);
    const list = await app.request("/v1/items/200/reviews");
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });
});
