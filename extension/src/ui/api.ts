import type {
  ApiErrorResponse,
  ApiMineResponse,
  ApiRatingsResponse,
  ApiRequestMessage,
  ApiResponseMessage,
  ApiReviewsResponse,
  ApiSummaryResponse,
} from "../shared/types";

/**
 * Content script 側のAPIクライアント。
 * fetch は Service Worker (background) にメッセージで依頼するだけ。
 */

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code?: string; message: string };

type ChromeRuntime = {
  sendMessage(
    message: ApiRequestMessage,
    callback: (response: unknown) => void,
  ): void;
  lastError?: { message?: string };
};

type ChromeLike = { runtime?: ChromeRuntime };

/** 停滞時に「読み込み中のまま」にならないよう、一定時間でタイムアウトさせる */
const CALL_TIMEOUT_MS = 20_000;

function runtimeApi(): ChromeRuntime {
  const c = globalThis as unknown as ChromeLike & { chrome?: ChromeLike };
  // Chrome の content script では chrome 名前空間は globalThis のプロパティ (globalThis.runtime ではない)
  const rt = c.runtime ?? c.chrome?.runtime;
  if (!rt || typeof rt.sendMessage !== "function") {
    throw new Error("chrome.runtime is unavailable in this context");
  }
  return rt;
}

export function apiCall<T>(
  method: ApiRequestMessage["method"],
  path: string,
  opts: { body?: unknown; anonId?: string } = {},
): Promise<ApiResult<T>> {
  const requestId = crypto.randomUUID();
  const runtime = runtimeApi();

  return new Promise((resolve) => {
    // Service Worker が起動していない/応答しない場合でも UI が固まらないようにする
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        status: 0,
        message: "バックグラウンド応答なし (拡張を再読込してください: chrome://extensions の更新ボタン)",
      });
    }, CALL_TIMEOUT_MS);
    const finish = (r: ApiResult<T>): void => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      runtime.sendMessage(
        { type: "api-request", requestId, method, path, body: opts.body, anonId: opts.anonId },
        (response) => {
          if (chrome.runtime.lastError) {
            finish({
              ok: false,
              status: 0,
              message: chrome.runtime.lastError.message ?? "extension runtime error",
            });
            return;
          }
          const resp = response as ApiResponseMessage | undefined;
          if (!resp || resp.type !== "api-response" || resp.requestId !== requestId) {
            finish({ ok: false, status: 0, message: "malformed response from service worker" });
            return;
          }
          if (resp.networkError || resp.status === 0) {
            finish({
              ok: false,
              status: 0,
              message: `ネットワークエラー: ${resp.error ?? "APIに接続できません"}`,
            });
            return;
          }
          if (!resp.ok) {
            const err = errorOf(resp.data);
            finish({
              ok: false,
              status: resp.status,
              code: err?.code,
              message: err?.message ?? `HTTP ${resp.status}`,
            });
            return;
          }
          finish({ ok: true, status: resp.status, data: resp.data as T });
        },
      );
    } catch (e) {
      finish({
        ok: false,
        status: 0,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

function errorOf(data: unknown): ApiErrorResponse["error"] | undefined {
  if (typeof data === "object" && data !== null && "error" in data) {
    const err = (data as { error?: unknown }).error;
    if (
      typeof err === "object" &&
      err !== null &&
      typeof (err as { code?: unknown }).code === "string" &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      const e = err as { code: string; message: string };
      return { code: e.code, message: e.message };
    }
  }
  return undefined;
}

// ---- 高レベルAPIラッパー ----

export type ReviewListResult = ApiResult<ApiReviewsResponse>;
export type SummaryResult = ApiResult<ApiSummaryResponse>;
export type MineResult = ApiResult<ApiMineResponse>;
export type MutationResult = ApiResult<
  { review: ApiMineResponse["review"] } & { created?: boolean } | { ok: true } | Record<string, unknown>
>;

export const api = {
  list(itemId: number, page: number): Promise<ReviewListResult> {
    return apiCall<ApiReviewsResponse>(
      "GET",
      `/v1/items/${itemId}/reviews?page=${page}`,
    );
  },
  summary(itemId: number): Promise<SummaryResult> {
    return apiCall<ApiSummaryResponse>("GET", `/v1/items/${itemId}/summary`);
  },
  mine(itemId: number, anonId: string): Promise<MineResult> {
    return apiCall<ApiMineResponse>("GET", `/v1/items/${itemId}/mine`, { anonId });
  },
  shopSummary(shop: string): Promise<SummaryResult> {
    return apiCall<ApiSummaryResponse>("GET", `/v1/shops/${shop}/summary`);
  },
  /** 一覧ページのカード用バッチ集計 (最大50件/リクエスト) */
  ratings(ids: number[]): Promise<ApiResult<ApiRatingsResponse>> {
    return apiCall<ApiRatingsResponse>("GET", `/v1/items/ratings?ids=${ids.join(",")}`);
  },
  shopList(shop: string, page: number): Promise<ReviewListResult> {
    return apiCall<ApiReviewsResponse>("GET", `/v1/shops/${shop}/reviews?page=${page}`);
  },
  post(
    itemId: number,
    rating: number,
    body: string,
    anonId: string,
    shop?: string | null,
  ): Promise<MutationResult> {
    return apiCall("POST", `/v1/items/${itemId}/reviews`, {
      body: { rating, body, anonId, ...(shop ? { shop } : {}) },
    });
  },
  patch(
    reviewId: number,
    patch: { rating?: number; body?: string },
    anonId: string,
    shop?: string | null,
  ): Promise<MutationResult> {
    return apiCall("PATCH", `/v1/reviews/${reviewId}`, {
      body: { ...patch, ...(shop ? { shop } : {}) },
      anonId,
    });
  },
  remove(reviewId: number, anonId: string): Promise<MutationResult> {
    return apiCall("DELETE", `/v1/reviews/${reviewId}`, { anonId });
  },
  report(reviewId: number, anonId: string): Promise<MutationResult> {
    return apiCall("POST", `/v1/reviews/${reviewId}/report`, {
      body: { anonId },
    });
  },
};
