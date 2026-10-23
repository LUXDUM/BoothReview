/**
 * 投稿本文のスパム判定 (単体テスト可能な純粋ロジック層)。
 *
 * - 本文に含めてよい URL は最大 1 個まで (宣伝スパム対策)
 * - 同一匿名IDによる同一本文の連投を一定時間内は拒否する
 *   (1商品1匿名IDの制約をすり抜けて複数商品に同じ文をまき散らす対策)
 *
 * 連投判定の記憶はメモリのみ (プロセス再起動で消える)。本文そのものは保存せず、
 * 判定に使う簡易ハッシュだけを保持する。
 */
import { Errors } from "./errors.js";

/** 本文に含めてよい URL の上限 */
export const MAX_URLS = 1;

/** 同一本文とみなす連投の禁止時間 (ミリ秒) */
export const REPOST_WINDOW_MS = 32 * 60 * 1000;

const URL_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;

/** URL 数の上限チェック。超過時は VALIDATION_ERROR */
export function assertBodyAllowed(body: string, maxUrls: number = MAX_URLS): void {
  const urls = body.match(URL_RE) ?? [];
  if (urls.length > maxUrls) {
    throw Errors.validation(`レビュー本文に URL は最大 ${maxUrls} 個までです`);
  }
}

/** 判定用の正規化: 空白の違いを同一扱いにする (褒め言葉の分解 vs 余白の違いを区別しない) */
function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** FNV-1a 簡易ハッシュ (連投判定専用。本文は保存しない) */
export function bodyKey(body: string): string {
  let h = 0x811c9dc5;
  const normalized = normalizeBody(body);
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export type RepostGuard = {
  /** 窓内に同一本文の投稿があれば CONFLICT。成功メモリには含まれない */
  assertNotRepost(authorHashHex: string, body: string): void;
  /** 成功した投稿を記録する (投稿/編集の直後に呼ぶ) */
  record(authorHashHex: string, body: string): void;
  /** テスト用: 記憶を消す */
  reset(): void;
};

export function createRepostGuard(
  now: () => number = () => Date.now(),
  windowMs: number = REPOST_WINDOW_MS,
): RepostGuard {
  /** authorHash → 記録済み本文ハッシュと時刻の配列 */
  const seen = new Map<string, Array<{ key: string; ts: number }>>();

  function prune(authorHashHex: string): void {
    const entries = seen.get(authorHashHex);
    if (!entries) return;
    const cutoff = now() - windowMs;
    const alive = entries.filter((e) => e.ts > cutoff);
    if (alive.length === 0) seen.delete(authorHashHex);
    else seen.set(authorHashHex, alive);
  }

  return {
    assertNotRepost(authorHashHex, body) {
      prune(authorHashHex);
      const entries = seen.get(authorHashHex);
      if (!entries) return;
      const key = bodyKey(body);
      const hit = entries.find((e) => e.key === key);
      if (hit) {
        throw Errors.conflict("同じ本文を短時間のうちに連続投稿することはできません");
      }
    },

    record(authorHashHex, body) {
      prune(authorHashHex);
      const entries = seen.get(authorHashHex) ?? [];
      const key = bodyKey(body);
      // 同一本文の再記録は時刻を更新するだけで重複を持たない
      const existing = entries.find((e) => e.key === key);
      if (existing) existing.ts = now();
      else entries.push({ key, ts: now() });
      seen.set(authorHashHex, entries);
    },

    reset() {
      seen.clear();
    },
  };
}
