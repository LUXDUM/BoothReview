import { describe, expect, it } from "vitest";
import { authorHash } from "../src/lib/hash.js";

describe("authorHash", () => {
  it("produces a deterministic 64-char hex hash", () => {
    const h1 = authorHash("pepper-secret-value", "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d");
    const h2 = authorHash("pepper-secret-value", "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across anon ids and peppers", () => {
    const pepper = "pepper-secret-value";
    const a = authorHash(pepper, "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d");
    const b = authorHash(pepper, "f81d4fae-7dec-11d0-a765-00a0c91e6bf6");
    expect(a).not.toBe(b);
    // pepper を変えると別の値になる (単純なハッシュテーブル攻撃の無効化)
    expect(a).not.toBe(authorHash("another-pepper-value", "c9bf9e57-1685-4c89-bafb-ffb5c70f1f2d"));
  });
});
