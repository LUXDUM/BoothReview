import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * 匿名IDの保存はサーバー側秘密値 (pepper) での HMAC-SHA256 ハッシュのみ。
 * 生の匿名IDはDBにも保存しない。ハッシュが漏洩しても、pepper がないと
 * 匿名IDへ逆算できず、また pepper を含まない単純ハッシュテーブル攻撃も無効。
 */
export function authorHash(pepper: string, anonId: string): string {
  return createHmac("sha256", pepper).update(anonId, "utf8").digest("hex");
}

/** ETag 用の内容ハッシュ (先頭16桁) */
export function contentHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/** トークン比較。タイミング攻撃を避けるため定数時間比較を使う */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // 長さが違う場合は不定値比較でも必ず false を返す
    timingSafeEqual(Buffer.alloc(16), Buffer.alloc(16));
    return false;
  }
  return timingSafeEqual(ab, bb);
}
