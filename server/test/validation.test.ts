import { describe, expect, it } from "vitest";
import {
  anonIdSchema,
  createBodySchema,
  createPerPageSchema,
  itemIdSchema,
  sanitizeBody,
} from "../src/lib/validation.js";

const bodySchema = createBodySchema({ minBodyLen: 10, maxBodyLen: 2000 });
const perPageSchema = createPerPageSchema({ perPageDefault: 10, perPageMax: 50 });

describe("sanitizeBody", () => {
  it("removes control characters and zero-width characters", () => {
    const input = "abc\u0000def\u200Bghi\u007Fjkl\uFEFF";
    expect(sanitizeBody(input)).toBe("abcdefghijkl");
  });

  it("trims whitespace but keeps interior newlines", () => {
    expect(sanitizeBody("  line1\nline2  ")).toBe("line1\nline2");
  });

  it("removes vertical tab and form feed", () => {
    expect(sanitizeBody("a\u000Bb\u000Cc")).toBe("abc");
  });
});

describe("body schema", () => {
  it("accepts body with at least min length after sanitize", () => {
    const result = bodySchema.safeParse("\u200B".repeat(5) + "0123456789a");
    expect(result.success).toBe(true);
  });

  it("rejects body shorter than min length", () => {
    const result = bodySchema.safeParse("short");
    expect(result.success).toBe(false);
  });

  it("rejects body longer than max length", () => {
    const result = bodySchema.safeParse("a".repeat(2001));
    expect(result.success).toBe(false);
  });

  it("counts characters after removing control characters", () => {
    // 制御文字だけでは長さを稼げない
    const padded = "x".repeat(9) + "\u200B";
    const result = bodySchema.safeParse(padded);
    expect(result.success).toBe(false);
  });
});

describe("rating / item id / anon id", () => {
  it("accepts rating 1..5 integers only", async () => {
    const { ratingSchema } = await import("../src/lib/validation.js");
    expect(ratingSchema.safeParse(3).success).toBe(true);
    expect(ratingSchema.safeParse(1).success).toBe(true);
    expect(ratingSchema.safeParse(5).success).toBe(true);
    expect(ratingSchema.safeParse(0).success).toBe(false);
    expect(ratingSchema.safeParse(6).success).toBe(false);
    expect(ratingSchema.safeParse(2.5).success).toBe(false);
    expect(ratingSchema.safeParse("3").success).toBe(false); // 型を厳密に (数値のみ)
  });

  it("accepts positive integer item id only", () => {
    expect(itemIdSchema.safeParse("12345").success).toBe(true);
    expect(itemIdSchema.safeParse("0").success).toBe(false);
    expect(itemIdSchema.safeParse("-1").success).toBe(false);
    expect(itemIdSchema.safeParse("12.5").success).toBe(false);
    expect(itemIdSchema.safeParse("99999999999999").success).toBe(false);
  });

  it("validates anon id UUID format", () => {
    expect(anonIdSchema.safeParse("c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d").success).toBe(true);
    expect(anonIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(anonIdSchema.safeParse("").success).toBe(false);
  });

  it("clamps perPage", () => {
    expect(perPageSchema.safeParse("1").success).toBe(true);
    expect(perPageSchema.safeParse("50").success).toBe(true);
    expect(perPageSchema.safeParse("51").success).toBe(false);
  });
});
