/**
 * シンプルな固定窓レート制限。単一APIプロセス内のメモリで動く。
 *
 * - IP / 匿名ID どちらのキーでも使える(キー文字列にはハッシュ化済みの匿名IDを使う)。
 * - 保存はメモリのみ。レビュー等の永続データと紐づけない。
 * - プロセス再起動でカウントはリセットされる(既知の挙動として README/docs に記載)。
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  /** この呼び出しが窓内で許可されるか(許可された場合はカウントを消費する) */
  hit(bucketKey: string, limit: number, windowMs: number): RateLimitResult;
  /** テスト用: すべてのカウントを消す */
  reset(): void;
};

type Window = { count: number; startedAt: number };

export function createRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const windows = new Map<string, Window>();

  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  function ensureCleanup(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const t = now();
      for (const [key, w] of windows) {
        // start から2窓以上経過したものを掃除(実運用の窓は最長1時間)
        if (t - w.startedAt > 2 * 60 * 60 * 1000) windows.delete(key);
      }
    }, 5 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  return {
    hit(bucketKey, limit, windowMs) {
      ensureCleanup();
      const t = now();
      const w = windows.get(bucketKey);
      if (!w || t - w.startedAt >= windowMs) {
        windows.set(bucketKey, { count: 1, startedAt: t });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }
      if (w.count >= limit) {
        const retryAfter = Math.max(1, Math.ceil((w.startedAt + windowMs - t) / 1000));
        return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
      }
      w.count += 1;
      return { allowed: true, remaining: limit - w.count, retryAfterSeconds: 0 };
    },
    reset() {
      windows.clear();
    },
  };
}
