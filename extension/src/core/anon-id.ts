/**
 * 匿名IDの管理 (chrome.storage.local)。
 *
 * 仕様 5.2:
 * - 初回起動時にランダム UUID を生成して chrome.storage.local に保存する
 * - 投稿・編集・削除・通報のリクエストに匿名IDを付与する
 * - 端末変更・再インストール・ストレージ削除で過去の投稿を編集/削除できなくなる (既知の制約)
 */

const ANON_ID_KEY = "anonId";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAnonId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type ChromeStorageLocal = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

type StorageApi = { local: ChromeStorageLocal };

type ChromeLike = { storage?: StorageApi };

function chromeApi(): StorageApi {
  const c = globalThis as unknown as ChromeLike & { chrome?: ChromeLike };
  // Chrome の content script では chrome 名前空間は globalThis のプロパティ (globalThis.storage ではない)
  const storage = c.storage ?? c.chrome?.storage;
  if (!storage || typeof storage.local?.get !== "function") {
    throw new Error("chrome.storage.local is unavailable in this context");
  }
  return storage;
}

/** 取得し、無ければ生成して保存して返す (失敗時は Error を投げる) */
export async function getOrCreateAnonId(): Promise<string> {
  const storage = chromeApi();
  const got = await storage.local.get(ANON_ID_KEY);
  const current = got[ANON_ID_KEY];
  if (isValidAnonId(current)) return current;

  const fresh = crypto.randomUUID();
  await storage.local.set({ [ANON_ID_KEY]: fresh });
  return fresh;
}
