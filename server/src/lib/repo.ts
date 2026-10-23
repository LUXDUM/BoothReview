/**
 * レビュー永続化のインターフェース。
 * ルート層はこの型にのみ依存し、テストではインメモリ実装(DBなし)で差し替える。
 */

export type ReviewStatus = "published" | "hidden" | "deleted";

export type ReviewRecord = {
  id: number;
  itemId: number;
  /** 匿名ID を pepper で HMAC-SHA256 したハッシュ (author_hash)。公開側では短縮頭8文字のみ出る */
  authorHash: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Summary = { reviewCount: number; ratingSum: number };

export type OwnLookup = { found: boolean; owned: boolean; review: ReviewRecord | null };

/** 投稿禁止 (BAN) の記録。管理ダッシュボードの一覧と解除に使う */
export type AuthorBlockRecord = {
  authorHash: string;
  reason: string | null;
  createdAt: Date;
  /** BAN解除の参照用に、この匿名IDのレビュー1件のID (レビューがない場合は null) */
  sampleReviewId: number | null;
};

export type ReviewRepository = {
  /** DB到達確認 (healthz) */
  ping(): Promise<void>;

  /** 公開中レビューの一覧 (作成日時の新しい順) */
  listPublishedReviews(
    itemId: number,
    page: number,
    perPage: number,
  ): Promise<{ items: ReviewRecord[]; total: number }>;

  /** 公開中レビューの集計 (集計テーブルから O(1) で読む) */
  getSummary(itemId: number): Promise<Summary>;

  /** 一覧ページ用の一括集計 (存在しない itemId は含まれない) */
  listSummaries(itemIds: number[]): Promise<Array<Summary & { itemId: number }>>;

  /** ショップ集計: そのショップのサブドメインが付いた公開レビューのみ */
  getShopSummary(shop: string): Promise<Summary>;

  /** ショップ集計: 公開レビュー一覧 (作成日時の新しい順) */
  listShopReviews(
    shop: string,
    page: number,
    perPage: number,
  ): Promise<{ items: ReviewRecord[]; total: number }>;

  /** 自分のレビュー (同一匿名ID = author_hash)。公開/非公開どちらも対象 */
  findReviewByAuthor(itemId: number, authorHashHex: string): Promise<ReviewRecord | null>;

  /**
   * 投稿。同一 (item_id, author_hash) があれば更新 (仕様 5.2: 再投稿は更新扱い)。
   * ステータスは変更しない(管理者/通報で非表示にされたものを投稿で復活させない)。
   */
  upsertReview(input: {
    itemId: number;
    authorHashHex: string;
    rating: number;
    body: string;
    /** 投稿元のショップサブドメイン (指定時のみ更新)。ショップ集計に使用 */
    shop?: string | undefined;
  }): Promise<{ review: ReviewRecord; created: boolean }>;

  getReview(id: number): Promise<ReviewRecord | null>;

  updateOwnReview(
    id: number,
    authorHashHex: string,
    patch: { rating?: number | undefined; body?: string | undefined; shop?: string | undefined },
  ): Promise<OwnLookup>;

  deleteOwnReview(id: number, authorHashHex: string): Promise<{ found: boolean; owned: boolean }>;

  /** 通報登録。同一 (review_id, reporter_hash) の重複は追加しない */
  addReport(reviewId: number, reporterHashHex: string): Promise<{ added: boolean }>;

  /** 対象レビューに付いた通報の総数 */
  countReports(reviewId: number): Promise<number>;

  /** 管理者操作 / 自動非表示: status の変更 (物理削除はしない) */
  setStatus(reviewId: number, status: ReviewStatus, hiddenReason: string | null): Promise<boolean>;

  /** 管理用一覧 (status / itemId / 本文検索 / 並び順で絞り込み, 通報数付き) */
  adminListReviews(filter: AdminListFilter): Promise<{ items: Array<ReviewRecord & { reportCount: number }>; total: number }>;

  /**
   * 管理ダッシュボード用の集計。ディスク/バックアップ等のホスト情報は
   * ルート層で付与するためここには含めない。
   */
  adminStats(): Promise<AdminStatsData>;

  /** 投稿禁止リスト (作成日時の新しい順) */
  listAuthorBlocks(): Promise<AuthorBlockRecord[]>;

  isAuthorBlocked(authorHashHex: string): Promise<boolean>;

  /** 登録済みでも上書きしない。戻り値は「本次新規に登録したか」 */
  blockAuthor(authorHashHex: string, reason: string | null): Promise<boolean>;

  unblockAuthor(authorHashHex: string): Promise<boolean>;
};

export type AdminListFilter = {
  status?: ReviewStatus | undefined;
  itemId?: number | undefined;
  /** 本文の部分一致検索 (LIKE) */
  query?: string | undefined;
  /** 匿名ID (生UUID) で検索 — ルート層でハッシュ化して渡される */
  authorHashHex?: string | undefined;
  /** 並び順。未指定は作成日時の新しい順 */
  order?: "created" | "reports" | undefined;
  page: number;
  perPage: number;
};

export type AdminStatsData = {
  counts: { total: number; published: number; hidden: number; deleted: number };
  /** 公開レビューのみ対象 */
  avgRating: number | null;
  /** rating 1..5 の分布 (公開レビューのみ)。index 0 = rating 1 */
  ratingDistribution: number[];
  /** 通報の総数 */
  reportTotal: number;
  /** 通報数の多いレビュー (上位 limit) */
  topReported: Array<ReviewRecord & { reportCount: number }>;
  /** 直近 days 日の日次投稿数 (未来・当日を含むゼロ埋め) */
  trend: Array<{ day: string; count: number }>;
  /** 公開レビューの多いアイテム TOP */
  topItems: Array<{ itemId: number; count: number }>;
  /** DB のサイズ */
  dbSizeBytes: number | null;
  /** テーブル別サイズ (未作成テーブルは含まれない) */
  tableSizes: Array<{ table: string; bytes: number }>;
};

export type BackupFile = { file: string; bytes: number; modifiedAt: string };

export type AdminStats = AdminStatsData & {
  /** ディスク使用状況 (取得できない環境では null) */
  disk: { totalBytes: number; freeBytes: number } | null;
  /** バックアップディレクトリの一覧 */
  backups: BackupFile[];
};
