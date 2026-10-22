import type {
  ApiErrorResponse,
  ApiMineResponse,
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

function runtimeApi(): ChromeRuntime {
  const c = globalThis as unknown as ChromeLike;
  if (!c.runtime || typeof c.runtime.sendMessage !== "function") {
    throw new Error("chrome.runtime is unavailable in this context");
  }
  return c.runtime;
}

export function apiCall<T>(
  method: ApiRequestMessage["method"],
  path: string,
  opts: { body?: unknown; anonId?: string } = {},
): Promise<ApiResult<T>> {
  const requestId = crypto.randomUUID();
  const runtime = runtimeApi();

  return new Promise((resolve) => {
    try {
      runtime.sendMessage(
        { type: "api-request", requestId, method, path, body: opts.body, anonId: opts.anonId },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              status: 0,
              message: chrome.runtime.lastError.message ?? "extension runtime error",
            });
            return;
          }
          const resp = response as ApiResponseMessage | undefined;
          if (!resp || resp.type !== "api-response" || resp.requestId !== requestId) {
            resolve({ ok: false, status: 0, message: "malformed response from service worker" });
            return;
          }
          if (resp.networkError || resp.status === 0) {
            resolve({
              ok: false,
              status: 0,
              message: `ネットワークエラー: ${resp.error ?? "APIに接続できません"}`,
            });
            return;
          }
          if (!resp.ok) {
            const err = errorOf(resp.data);
            resolve({
              ok: false,
              status: resp.status,
              code: err?.code,
              message: err?.message ?? `HTTP ${resp.status}`,
            });
            return;
          }
          resolve({ ok: true, status: resp.status, data: resp.data as T });
        },
      );
    } catch (e) {
      resolve({
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
  post(itemId: number, rating: number, body: string, anonId: string): Promise<MutationResult> {
    return apiCall("POST", `/v1/items/${itemId}/reviews`, {
      body: { rating, body, anonId },
    });
  },
  patch(
    reviewId: number,
    patch: { rating?: number; body?: string },
    anonId: string,
  ): Promise<MutationResult> {
    return apiCall("PATCH", `/v1/reviews/${reviewId}`, {
      body: patch,
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
