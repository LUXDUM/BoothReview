import { beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/routes/http.js";
import { parseConfig } from "../src/config.js";
import { createMemoryRepository } from "./helpers/memory-repo.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { silentLogger } from "./helpers/logger.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const config = parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/test",
    PEPPER: "unit-test-pepper-0123456789",
    ADMIN_TOKEN: "unit-test-admin-token-0123456789",
  });
  const deps: AppDeps = {
    config,
    repo: createMemoryRepository(),
    limiter: createRateLimiter(),
    logger: silentLogger,
  };
  app = createApp(deps);
});

describe("GET /privacy", () => {
  it("returns the privacy policy page (200, ja, no external resources)", async () => {
    const res = await app.request("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>BOOTHReview プライバシーポリシー</title>");
    expect(html).toContain("IPアドレス");
    // 外部スクリプト・トラッカー無し
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"]*track|analytics/i);
  });

  it("does not require auth and is not a JSON error body", async () => {
    const res = await app.request("/privacy");
    expect(res.status).toBe(200);
    const type = res.headers.get("content-type") ?? "";
    expect(type).not.toContain("application/json");
  });
});
