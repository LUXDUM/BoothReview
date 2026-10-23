/** API DTO / メッセージ型の共有定義 */

export type ApiReview = {
  id: number;
  /** 投稿者の匿名ID短縮ハッシュ (頭8文字。サーバー側で付与される) */
  author?: string;
  /** ショップ集計 (/v1/shops/:shop/reviews) の一覧でのみ付く */
  itemId?: number;
  rating: number;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiReviewsResponse = {
  reviews: ApiReview[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type ApiSummaryResponse = {
  count: number;
  average: number | null;
};

/** GET /v1/items/ratings?ids=... の応答。レビューが無い item は含まれない */
export type ApiRatingsResponse = {
  ratings: Record<string, ApiSummaryResponse>;
};

export type ApiMineResponse = {
  review: ApiReview | null;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
  };
};

/** Content Script → Service Worker のメッセージ型 */
export type ApiRequestMessage =
  | {
      type: "api-request";
      requestId: string;
      method: "GET" | "POST" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      anonId?: string; // 送信時にヘッダ X-Anon-ID に変換される
    };

export type ApiResponseMessage =
  | {
      type: "api-response";
      requestId: string;
      ok: boolean;
      status: number;
      data: unknown;
      networkError?: true;
      error?: string;
    };
