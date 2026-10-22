import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/lib/rate-limit.js";

describe("rate limiter", () => {
  it("allows up to the limit within the window", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const r1 = limiter.hit("b", 3, 1000);
    const r2 = limiter.hit("b", 3, 1000);
    const r3 = limiter.hit("b", 3, 1000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  it("blocks after the limit and reports retry-after", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    limiter.hit("b", 2, 1000);
    limiter.hit("b", 2, 1000);
    const r = limiter.hit("b", 2, 1000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(1);
  });

  it("resets after the window passes", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    limiter.hit("b", 1, 1000);
    expect(limiter.hit("b", 1, 1000).allowed).toBe(false);
    now = 2000; // 次の窓
    expect(limiter.hit("b", 1, 1000).allowed).toBe(true);
  });

  it("uses independent buckets per key", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    expect(limiter.hit("a", 1, 1000).allowed).toBe(true);
    expect(limiter.hit("b", 1, 1000).allowed).toBe(true);
    expect(limiter.hit("a", 1, 1000).allowed).toBe(false);
  });

  it("reports retry seconds for long windows", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    limiter.hit("b", 1, 60000);
    limiter.hit("b", 1, 60000);
    const r = limiter.hit("b", 1, 60000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(60);
  });
});
