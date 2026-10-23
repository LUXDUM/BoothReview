import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { promises as fsp } from "node:fs";
import { z, ZodError } from "zod";
import type { Config } from "../config.js";
import type { ReviewRecord, ReviewRepository, ReviewStatus } from "../lib/repo.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import type { Logger } from "../lib/logger.js";
import { AppError, Errors, errorBody } from "../lib/errors.js";
import {
  adminStatusSchema,
  anonIdSchema,
  createBodySchema,
  createPerPageSchema,
  itemIdSchema,
  pageSchema,
  ratingSchema,
  shopSchema,
} from "../lib/validation.js";
import { authorHash } from "../lib/hash.js";
import { extractClientIp } from "../lib/ip.js";
import { assertBodyAllowed, createRepostGuard, type RepostGuard } from "../lib/moderation.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

/** BAN 匿名ID向けのエラー文言 (拡張機能のフォームにそのまま表示される) */
const BANNED_MESSAGE = "この匿名IDは管理者により投稿が禁止されています";

export type AppDeps = {
  config: Config;
  repo: ReviewRepository;
  limiter: RateLimiter;
  logger: Logger;
  /** 同一本文連投の判定 (省略時は実時間のインメモリ実装)。テストで時計を差し替える */
  repostGuard?: RepostGuard;
};

type PublicReview = {
  id: number;
  /** 投稿者の匿名ID短縮ハッシュ (先頭8文字。UUID自体は返さない。なりすまし防止のため) */
  author: string;
  rating: number;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 公開レスポンス。匿名IDの生値とフルハッシュは返さない (短縮ハッシュのみ)。
 * フルハッシュがないと本人確認 (PATCH/DELETE) のなりすましができないため。
 */
function toPublic(r: ReviewRecord): PublicReview {
  return {
    id: r.id,
    author: r.authorHash.slice(0, 8),
    rating: r.rating,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toAdminReview(r: ReviewRecord & { reportCount: number }) {
  return {
    id: r.id,
    itemId: r.itemId,
    /** 匿名IDのハッシュ短縮 (管理UIの検索/識別用。管理画面でしか出ない) */
    author: r.authorHash.slice(0, 8),
    rating: r.rating,
    body: r.body,
    status: r.status,
    hiddenReason: r.hiddenReason,
    reportCount: r.reportCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toZodErrorMessage(e: ZodError): string {
  const first = e.issues[0];
  const path = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first?.message ?? "invalid input"}`;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw Errors.validation("request body must be valid JSON");
  }
}

function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw Errors.validation(toZodErrorMessage(result.error));
  return result.data as z.output<S>;
}

/** FNV-1a。ETag 用の簡易ハッシュ (内容が同一なら同一値) */
function contentHash(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 管理トークン比較 (定数時間) */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

type Req = {
  req: {
    param(name: string): string;
    query(name: string): string | undefined;
    header(name: string): string | undefined;
    json(): Promise<unknown>;
  };
  env?: { incoming?: { socket?: { remoteAddress?: string } } };
};

function clientIpOf(c: Req): string | null {
  const headers = new Headers();
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) headers.set("cf-connecting-ip", cfIp);
  const { ip } = extractClientIp({
    remoteAddress: c.env?.incoming?.socket?.remoteAddress ?? null,
    headers,
    trustedProxyCidrs: [],
    // config.trustedProxyCidrs
  });
  return ip;
}

export function createApp(deps: AppDeps): Hono {
  const { config, repo, limiter, logger } = deps;

  const bodySchema = createBodySchema(config);
  const perPageSchema = createPerPageSchema(config);
  // 同一本文連投の判定 (メモリ内。プロセス再起動でリセット)
  const repostGuard = deps.repostGuard ?? createRepostGuard();

  const app = new Hono();

  // --- 共通ミドルウェア ---

  if (config.corsOrigins.length > 0) {
    app.use("/v1/*", cors({ origin: config.corsOrigins }));
  }

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        new Response(JSON.stringify(errorBody("VALIDATION_ERROR", "request body too large")), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    }),
  );

  // 構造化リクエストログ。IPや本文は出力しない。
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      },
      "request",
    );
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      const headers: Record<string, string> = {};
      if (err.code === "RATE_LIMITED" && typeof err.extra?.retryAfterSeconds === "number") {
        headers["Retry-After"] = String(Math.ceil(err.extra.retryAfterSeconds));
      }
      // err.status は 400/401/403/404/409/429/500 のいずれかに限る (STATUS_BY_CODE)
      const status = err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500;
      return c.json(errorBody(err.code, err.message, err.extra), status, headers);
    }
    if (err instanceof ZodError) {
      return c.json(errorBody("VALIDATION_ERROR", toZodErrorMessage(err)), 400);
    }
    logger.error({ err }, "unhandled error");
    return c.json(errorBody("INTERNAL_ERROR", "internal server error"), 500);
  });

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "route not found"), 404));

  // --- helpers ---

  const asReq = (c: unknown): Req => c as Req;

  function clientIp(c: unknown): string | null {
    const r = asReq(c);
    const headers = new Headers();
    const cfIp = r.req.header("cf-connecting-ip");
    if (cfIp) headers.set("cf-connecting-ip", cfIp);
    const { ip } = extractClientIp({
      remoteAddress: r.env?.incoming?.socket?.remoteAddress ?? null,
      headers,
      trustedProxyCidrs: config.trustedProxyCidrs,
    });
    return ip;
  }

  function ipBucketKey(prefix: string, c: unknown): string {
    return `${prefix}:ip:${clientIp(c) ?? "unknown"}`;
  }

  function requireAnonHeader(c: unknown): string {
    const raw = asReq(c).req.header("x-anon-id");
    if (!raw) throw Errors.validation("X-Anon-ID header is required");
    return parseWith(anonIdSchema, raw);
  }

  function limitOrThrow(bucketKey: string, limit: number, windowMs: number): void {
    const r = limiter.hit(bucketKey, limit, windowMs);
    if (!r.allowed) throw Errors.rateLimited(r.retryAfterSeconds);
  }

  async function numericParam(c: unknown, name: "itemId" | "id"): Promise<number> {
    return parseWith(itemIdSchema, asReq(c).req.param(name));
  }

  /** 公開 GET 用: ETag + Cache-Control と If-None-Match → 304 */
  function setCacheHeaders(c: unknown, payloadJson: string): boolean {
    const req = asReq(c).req;
    const etag = `"${contentHash(payloadJson)}"`;
    const res = c as { header(name: string, value: string): void };
    res.header("Cache-Control", `public, max-age=${config.cacheMaxAgeSeconds}`);
    res.header("ETag", etag);
    const inm = req.header("if-none-match");
    if (inm !== undefined && inm.split(",").map((s) => s.trim()).includes(etag)) {
      return true; // caller returns 304
    }
    return false;
  }

  // --- routes ---

  app.get("/healthz", async (c) => {
    try {
      await repo.ping();
      return c.json({ status: "ok", db: "ok" });
    } catch (e) {
      logger.error({ err: e }, "healthz db check failed");
      return c.json(errorBody("INTERNAL_ERROR", "db unavailable"), 503);
    }
  });

  // プライバシーポリシー (公開・静的・外部リソース無し)
  app.get("/privacy", (c) => c.html(PRIVACY_HTML));

  app.get("/v1/items/:itemId/reviews", async (c) => {
    limitOrThrow(
      ipBucketKey("list", c),
      config.rateLimits.listPerIpPerMinute,
      MINUTE_MS,
    );
    const itemId = await numericParam(c, "itemId");
    const page = parseWith(pageSchema, asReq(c).req.query("page") ?? "1");
    const perPage = parseWith(
      perPageSchema,
      asReq(c).req.query("perPage") ?? String(config.perPageDefault),
    );

    const { items, total } = await repo.listPublishedReviews(itemId, page, perPage);
    const payload = {
      reviews: items.map(toPublic),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
    const json = JSON.stringify(payload);
    if (setCacheHeaders(c, json)) return c.body(null, 304);
    return c.json(payload);
  });

  app.get("/v1/items/ratings", async (c) => {
    // 一覧ページのカード評価表示用の一括取得。1 リクエストあたり最大 50 件。
    limitOrThrow(ipBucketKey("list", c), config.rateLimits.listPerIpPerMinute, MINUTE_MS);
    const idsRaw = asReq(c).req.query("ids") ?? "";
    const ids = Array.from(
      new Set(
        idsRaw
          .split(",")
          .filter((s) => s.trim() !== "")
          .map((s) => parseWith(itemIdSchema, s)),
      ),
    ).slice(0, 50);
    if (ids.length === 0) throw Errors.validation("ids query required");
    const summaryList = await repo.listSummaries(ids);
    const ratings: Record<string, { count: number; average: number | null }> = {};
    for (const s of summaryList) {
      // レビュー 0 件の商品は値を返さない (フロント側は「未取得=レビューなし」として扱う)
      if (s.reviewCount === 0) continue;
      ratings[String(s.itemId)] = {
        count: s.reviewCount,
        average: Number((s.ratingSum / s.reviewCount).toFixed(2)),
      };
    }
    const payload = { ratings };
    const json = JSON.stringify(payload);
    if (setCacheHeaders(c, json)) return c.body(null, 304);
    return c.json(payload);
  });

  app.get("/v1/items/:itemId/summary", async (c) => {
    limitOrThrow(
      ipBucketKey("list", c),
      config.rateLimits.listPerIpPerMinute,
      MINUTE_MS,
    );
    const itemId = await numericParam(c, "itemId");
    const { reviewCount, ratingSum } = await repo.getSummary(itemId);
    const payload = {
      count: reviewCount,
      average: reviewCount === 0 ? null : Number((ratingSum / reviewCount).toFixed(2)),
    };
    const json = JSON.stringify(payload);
    if (setCacheHeaders(c, json)) return c.body(null, 304);
    return c.json(payload);
  });

  // --- ショップ集計 (投稿時に記録したサブドメイン単位) ---

  app.get("/v1/shops/:shop/summary", async (c) => {
    limitOrThrow(ipBucketKey("list", c), config.rateLimits.listPerIpPerMinute, MINUTE_MS);
    const shop = parseWith(shopSchema, asReq(c).req.param("shop"));
    const { reviewCount, ratingSum } = await repo.getShopSummary(shop);
    const payload = {
      count: reviewCount,
      average: reviewCount === 0 ? null : Number((ratingSum / reviewCount).toFixed(2)),
    };
    const json = JSON.stringify(payload);
    if (setCacheHeaders(c, json)) return c.body(null, 304);
    return c.json(payload);
  });

  app.get("/v1/shops/:shop/reviews", async (c) => {
    limitOrThrow(ipBucketKey("list", c), config.rateLimits.listPerIpPerMinute, MINUTE_MS);
    const shop = parseWith(shopSchema, asReq(c).req.param("shop"));
    const page = parseWith(pageSchema, asReq(c).req.query("page") ?? "1");
    const perPage = parseWith(
      perPageSchema,
      asReq(c).req.query("perPage") ?? String(config.perPageDefault),
    );
    const { items, total } = await repo.listShopReviews(shop, page, perPage);
    const payload = {
      // ショップ一覧では元商品へのリンクのために itemId を追加する
      reviews: items.map((r) => ({ ...toPublic(r), itemId: r.itemId })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
    const json = JSON.stringify(payload);
    if (setCacheHeaders(c, json)) return c.body(null, 304);
    return c.json(payload);
  });

  app.get("/v1/items/:itemId/mine", async (c) => {
    limitOrThrow(
      ipBucketKey("mine", c),
      config.rateLimits.minePerIpPerMinute,
      MINUTE_MS,
    );
    const itemId = await numericParam(c, "itemId");
    const anonId = requireAnonHeader(c);
    const hash = authorHash(config.pepper, anonId);
    const review = await repo.findReviewByAuthor(itemId, hash);
    // 削除済み (deleted) は「自分のレビューが無い」扱い (再投稿できる)
    return c.json({ review: review && review.status !== "deleted" ? toPublic(review) : null });
  });

  app.post("/v1/items/:itemId/reviews", async (c) => {
    const itemId = await numericParam(c, "itemId");
    const input = parseWith(
      z.object({
        rating: ratingSchema,
        body: bodySchema,
        anonId: anonIdSchema,
        /** 投稿元URLから採取したショップのサブドメイン (省略可) */
        shop: shopSchema.optional(),
      }),
      await readJson(c),
    );
    const hash = authorHash(config.pepper, input.anonId);
    // BAN 照合 (投稿禁止の匿名IDは新規投稿/更新ともに 403)
    if (await repo.isAuthorBlocked(hash)) throw Errors.forbidden(BANNED_MESSAGE);
    limitOrThrow(
      `post:anon:${hash}`,
      config.rateLimits.postPerAnonPerHour,
      HOUR_MS,
    );

    // 自分のレビューの書き直し (upsert の更新経路) はバースト制限・連投判定の対象外
    const existing = await repo.findReviewByAuthor(itemId, hash);
    if (!existing) {
      // バースト対策: 直近5分に同一IPから新規投稿ばかり来るのを止める
      limitOrThrow(ipBucketKey("post5", c), config.rateLimits.postPerIpPer5Min, FIVE_MIN_MS);
      limitOrThrow(
        ipBucketKey("post", c),
        config.rateLimits.postPerIpPerHour,
        HOUR_MS,
      );
      repostGuard.assertNotRepost(hash, input.body);
    }

    // 本文の機械的スパム判定 (URL 数上限) は更新時も適用する
    assertBodyAllowed(input.body);

    const { review, created } = await repo.upsertReview({
      itemId,
      authorHashHex: hash,
      rating: input.rating,
      body: input.body,
      shop: input.shop,
    });
    repostGuard.record(hash, review.body);
    return c.json({ review: toPublic(review), created }, created ? 201 : 200);
  });

  app.patch("/v1/reviews/:id", async (c) => {
    const id = await numericParam(c, "id");
    const anonId = requireAnonHeader(c);
    const hash = authorHash(config.pepper, anonId);
    // BAN 照合 (書き込みはすべて禁止。自分のレビューの削除のみ DELETE で可能にしてある)
    if (await repo.isAuthorBlocked(hash)) throw Errors.forbidden(BANNED_MESSAGE);
    const input = parseWith(
      z
        .object({
          rating: ratingSchema.optional(),
          body: bodySchema.optional(),
          /** 編集時にショップ紐付けを追加 / 更新する場合に使用 (省略時は変更しない) */
          shop: shopSchema.optional(),
        })
        .refine(
          (v) => v.rating !== undefined || v.body !== undefined || v.shop !== undefined,
          { message: "at least one of rating, body or shop is required" },
        ),
      await readJson(c),
    );
    if (input.body !== undefined) {
      assertBodyAllowed(input.body);
      repostGuard.assertNotRepost(hash, input.body);
    }
    const res = await repo.updateOwnReview(id, hash, {
      rating: input.rating,
      body: input.body,
      shop: input.shop,
    });
    if (!res.found) throw Errors.notFound();
    if (!res.owned) throw Errors.forbidden();
    if (res.owned && input.body !== undefined) repostGuard.record(hash, input.body);
    return c.json({ review: res.review ? toPublic(res.review) : null });
  });

  app.delete("/v1/reviews/:id", async (c) => {
    const id = await numericParam(c, "id");
    const anonId = requireAnonHeader(c);
    const hash = authorHash(config.pepper, anonId);
    const res = await repo.deleteOwnReview(id, hash);
    if (!res.found) throw Errors.notFound();
    if (!res.owned) throw Errors.forbidden();
    return c.json({ ok: true });
  });

  app.post("/v1/reviews/:id/report", async (c) => {
    const id = await numericParam(c, "id");
    limitOrThrow(
      ipBucketKey("report", c),
      config.rateLimits.reportPerIpPerHour,
      HOUR_MS,
    );
    const input = parseWith(
      z.object({ anonId: anonIdSchema }),
      await readJson(c),
    );
    const hash = authorHash(config.pepper, input.anonId);
    // BAN 照合 (禁止された匿名IDの通報は自動hiddenの閾値に影響させない)
    if (await repo.isAuthorBlocked(hash)) throw Errors.forbidden(BANNED_MESSAGE);
    limitOrThrow(
      `report:anon:${hash}`,
      config.rateLimits.reportPerAnonPerHour,
      HOUR_MS,
    );

    const review = await repo.getReview(id);
    if (!review || review.status === "deleted") throw Errors.notFound();
    if (review.status !== "published") {
      throw Errors.validation("this review is not open for reports");
    }
    const { added } = await repo.addReport(id, hash);
    if (!added) throw Errors.alreadyReported();
    const reportCount = await repo.countReports(id);
    if (reportCount >= config.reportAutoHideThreshold && review.status === "published") {
      await repo.setStatus(id, "hidden", "auto_report");
      logger.warn({ reviewId: id, reportCount }, "review auto-hidden by reports");
    }
    return c.json({ ok: true });
  });

  // --- 管理用 (ADMIN_TOKEN) ---

  app.use("/v1/admin/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (!safeCompare(auth, `Bearer ${config.adminToken}`)) {
      throw Errors.unauthorized();
    }
    await next();
  });

  // --- 管理ダッシュボード ---

  // HTML シェル (データは Bearer 認証付きで /v1/admin/stats から取得するため、シェル自体は公開で可)
  app.get("/admin/dashboard", (c) => c.html(DASHBOARD_HTML));

  // ディスク使用率 (失敗時は null → UI で「取得不可」表示)
  async function diskUsage(): Promise<{ totalBytes: number; freeBytes: number } | null> {
    try {
      const s = await fsp.statfs("/");
      return {
        totalBytes: Number(s.blocks) * Number(s.bsize),
        freeBytes: Number(s.bavail) * Number(s.bsize),
      };
    } catch {
      return null;
    }
  }

  // バックアップディレクトリの一覧 (read-only マウント前提。無い場合は空)
  async function listBackups(dir: string) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const st = await fsp.stat(`${dir}/${e.name}`);
        out.push({ file: e.name, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
      out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return out;
    } catch {
      return [];
    }
  }

  app.get("/v1/admin/stats", async (c) => {
    limitOrThrow(`admin:${clientIp(c) ?? "unknown"}`, config.rateLimits.adminPerIpPerMinute, MINUTE_MS);
    const data = await repo.adminStats();
    const [disk, backups] = await Promise.all([diskUsage(), listBackups(config.backupDir)]);
    return c.json({ ...data, disk, backups });
  });

  app.get("/v1/admin/reviews", async (c) => {
    const statusParam = asReq(c).req.query("status");
    const status: ReviewStatus | undefined = statusParam
      ? parseWith(adminStatusSchema, statusParam)
      : undefined;
    const itemIdRaw = asReq(c).req.query("itemId");
    const itemId = itemIdRaw ? parseWith(itemIdSchema, itemIdRaw) : undefined;
    const queryRaw = asReq(c).req.query("query");
    const query = queryRaw ? parseWith(z.string().min(1).max(200), queryRaw) : undefined;
    // 匿名ID (生UUID) で検索: サーバー側でハッシュ化してから照合する
    const anonIdRaw = asReq(c).req.query("anonId");
    const authorHashHex = anonIdRaw ? authorHash(config.pepper, parseWith(anonIdSchema, anonIdRaw)) : undefined;
    const orderRaw = asReq(c).req.query("order");
    const order = orderRaw
      ? parseWith(z.enum(["created", "reports"]), orderRaw)
      : undefined;
    const page = parseWith(pageSchema, asReq(c).req.query("page") ?? "1");
    const perPage = parseWith(
      perPageSchema,
      asReq(c).req.query("perPage") ?? String(config.perPageDefault),
    );
    const { items, total } = await repo.adminListReviews({
      status,
      itemId,
      query,
      authorHashHex,
      order,
      page,
      perPage,
    });
    return c.json({
      reviews: items.map(toAdminReview),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  });

  app.patch("/v1/admin/reviews/:id", async (c) => {
    const id = await numericParam(c, "id");
    const { status } = parseWith(
      z.object({ status: adminStatusSchema }),
      await readJson(c),
    );
    const hiddenReason = status === "hidden" ? "admin" : null;
    const ok = await repo.setStatus(id, status, hiddenReason);
    if (!ok) throw Errors.notFound();
    const review = await repo.getReview(id);
    const reportCount = await repo.countReports(id);
    return c.json({
      review: review ? toAdminReview({ ...review, reportCount }) : null,
    });
  });

  // --- 投稿禁止 (BAN) 管理 ---
  // 匿名IDのフルハッシュはAPIに一切出さない方針のため、追加/解除ともに
  // 「対象レビューの ID」経由で匿名IDを参照する。

  app.get("/v1/admin/blocks", async (c) => {
    limitOrThrow(`admin:${clientIp(c) ?? "unknown"}`, config.rateLimits.adminPerIpPerMinute, MINUTE_MS);
    const blocks = await repo.listAuthorBlocks();
    return c.json({
      blocks: blocks.map((b) => ({
        /** 短縮ハッシュ (管理UIの識別用) */
        author: b.authorHash.slice(0, 8),
        reason: b.reason,
        sampleReviewId: b.sampleReviewId,
        createdAt: b.createdAt.toISOString(),
      })),
      total: blocks.length,
    });
  });

  app.post("/v1/admin/blocks", async (c) => {
    limitOrThrow(`admin:${clientIp(c) ?? "unknown"}`, config.rateLimits.adminPerIpPerMinute, MINUTE_MS);
    const { reviewId } = parseWith(
      z.object({ reviewId: z.number().int().positive() }),
      await readJson(c),
    );
    const review = await repo.getReview(reviewId);
    if (!review) throw Errors.notFound(`review #${reviewId} not found`);
    const created = await repo.blockAuthor(review.authorHash, `review:${reviewId}`);
    if (created) {
      logger.warn({ reviewId, author: review.authorHash.slice(0, 8) }, "author blocked");
    }
    return c.json({
      ok: true,
      /** 新規登録なら true。すでに禁止済みなら false (冪等) */
      created,
      block: { author: review.authorHash.slice(0, 8), reviewId },
    });
  });

  app.delete("/v1/admin/blocks/:id", async (c) => {
    limitOrThrow(`admin:${clientIp(c) ?? "unknown"}`, config.rateLimits.adminPerIpPerMinute, MINUTE_MS);
    const reviewId = await numericParam(c, "id");
    const review = await repo.getReview(reviewId);
    if (!review) throw Errors.notFound(`review #${reviewId} not found`);
    const removed = await repo.unblockAuthor(review.authorHash);
    return c.json({ ok: true, removed });
  });

  return app;
}

/**
 * 管理ダッシュボード (HTMLシェル)。
 * - データは /v1/admin/stats を Bearer 付き fetch で取得する (シェル自体はデータを含まない)
 * - 外部スクリプト/CSS 不使用。本文は textContent で描画する (XSS 対策)
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOOTHReview 管理ダッシュボード</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #222; font-size: 14px; }
  header { background: #173a5e; color: #fff; padding: 14px 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header .spacer { flex: 1; }
  main { max-width: 1080px; margin: 0 auto; padding: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 12px 14px; }
  .card .k { color: #6b7280; font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 2px; }
  section { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
  section h2 { font-size: 14px; margin: 0 0 10px; color: #173a5e; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { color: #6b7280; font-weight: 600; font-size: 12px; white-space: nowrap; }
  td .clip { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .barwrap { display: flex; align-items: flex-end; gap: 3px; height: 90px; padding-top: 4px; }
  .barwrap .bar { flex: 1; background: #2f6fab; border-radius: 2px 2px 0 0; min-height: 1px; position: relative; }
  .barwrap .bar.zero { background: #e5e7eb; }
  .barwrap .bar span { display: none; }
  .barwrap .bar:hover span { display: block; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #173a5e; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 11px; white-space: nowrap; z-index: 2; }
  .hbar { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .hbar .lab { width: 2em; text-align: right; color: #6b7280; font-size: 12px; }
  .hbar .track { flex: 1; max-width: 480px; background: #eef0f3; border-radius: 4px; height: 14px; overflow: hidden; }
  .hbar .fill { height: 100%; background: #e8a013; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.published { background: #e3f5e9; color: #1c7c3c; }
  .badge.hidden { background: #fdecea; color: #b3261e; }
  .badge.deleted { background: #ececec; color: #666; }
  .muted { color: #6b7280; }
  button { font: inherit; }
  #login, #error { max-width: 380px; margin: 12vh auto; text-align: center; background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 22px; }
  #error { color: #b3261e; }
  input[type=password] { width: 100%; padding: 8px; border: 1px solid #cbd2da; border-radius: 6px; font: inherit; box-sizing: border-box; }
  input[type=text] { padding: 8px; border: 1px solid #cbd2da; border-radius: 6px; font: inherit; box-sizing: border-box; }
  .searchrow { display: flex; gap: 8px; }
  .searchrow input[type=text] { flex: 1; }
  .anonid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .btn { background: #0074c8; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
  .btn:disabled { opacity: .5; cursor: default; }
  .ghost { background: #eef0f3; color: #333; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  a { color: #0074c8; }
</style>
</head>
<body>
<div id="login" hidden>
  <h2>BOOTHReview 管理ダッシュボード</h2>
  <p class="muted">ADMIN_TOKEN を入力してください</p>
  <p><input id="token" type="password" placeholder="ADMIN_TOKEN" autofocus></p>
  <p><button id="loginBtn" class="btn" type="button">ログイン</button></p>
</div>
<div id="error" hidden></div>
<div id="app" hidden style="display:none">
  <header>
    <h1>BOOTHReview 管理ダッシュボード</h1>
    <span class="spacer"></span>
    <button id="reload" class="ghost" type="button">更新</button>
    <span id="at" class="muted" style="font-size:12px"></span>
  </header>
  <main>
    <div id="cards" class="cards"></div>
    <section><h2>星評価の分布 (公開レビュー)</h2><div id="dist"></div></section>
    <section><h2>投稿の推移 (直近30日・全ステータス)</h2><div id="trend" class="barwrap"></div></section>
    <section><h2>通報の多いレビュー</h2><div id="reported"></div></section>
    <section><h2>レビュー検索 (本文 / 匿名ID) と削除</h2>
      <div class="searchrow">
        <input id="sq" type="text" placeholder="本文の部分一致 (未入力可)">
        <input id="sanon" type="text" placeholder="匿名ID (UUIDをペースト)">
        <button id="sbtn" class="btn" type="button">検索</button>
      </div>
      <div id="smsg" class="muted" style="margin-top:6px; font-size:12px">本文または匿名IDのどちらかを入力してください。匿名IDは拡張機能の「あなたの匿名ID」表示からコピーできます。</div>
      <div id="sresults" style="margin-top:10px"></div>
    </section>
    <section><h2>投稿禁止 (BAN) リスト</h2><div id="blocks"></div></section>
    <section><h2>レビューの多いアイテム (公開)</h2><div id="items"></div></section>
    <section><h2>サーバー容量</h2><div id="server"></div></section>
  </main>
</div>
<script>
(function () {
  "use strict";
  var KEY = "br-admin-token";
  var $ = function (id) { return document.getElementById(id); };
  function mb(n) { return (n / 1024 / 1024).toFixed(1) + " MB"; }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function statusName(status) {
    return { published: "公開", hidden: "非表示", deleted: "削除" }[status] || status;
  }
  function fmtBytes(n) { return n === null || n === undefined ? "―" : mb(n); }

  function renderCards(d) {
    var c = d.counts;
    var cards = [
      ["レビュー (合計)", c.total],
      ["公開", c.published],
      ["非表示", c.hidden],
      ["削除", c.deleted],
      ["平均評価 (公開)", d.avgRating === null ? "―" : d.avgRating.toFixed(2)],
      ["通報 (合計)", d.reportTotal]
    ];
    var wrap = $("cards"); wrap.textContent = "";
    for (var i = 0; i < cards.length; i++) {
      var card = el("div", "card");
      card.append(el("div", "k", cards[i][0]), el("div", "v", String(cards[i][1])));
      wrap.append(card);
    }
    if (d.disk) {
      var diskCard = el("div", "card");
      var used = d.disk.totalBytes - d.disk.freeBytes;
      diskCard.append(el("div", "k", "ディスク使用率"));
      diskCard.append(el("div", "v", Math.round(used / d.disk.totalBytes * 100) + "%"));
      wrap.appendChild(diskCard);
    }
  }

  function renderDist(d) {
    var wrap = $("dist"); wrap.textContent = "";
    var max = Math.max.apply(null, d.ratingDistribution.concat([1]));
    for (var r = 5; r >= 1; r--) {
      var row = el("div", "hbar");
      row.append(el("span", "lab", r + "★"));
      var track = el("div", "track");
      var fill = el("div", "fill");
      fill.style.width = Math.round(d.ratingDistribution[r - 1] / max * 100) + "%";
      track.appendChild(fill);
      row.append(track, el("span", "muted", String(d.ratingDistribution[r - 1])));
      wrap.appendChild(row);
    }
  }

  function renderTrend(d) {
    var wrap = $("trend"); wrap.textContent = "";
    var max = Math.max.apply(null, d.trend.map(function (t) { return t.count; }).concat([1]));
    for (var i = 0; i < d.trend.length; i++) {
      var bar = el("div", "bar" + (d.trend[i].count === 0 ? " zero" : ""));
      bar.style.height = Math.max(2, Math.round(d.trend[i].count / max * 84)) + "px";
      var tip = el("span", "", d.trend[i].day + " : " + d.trend[i].count + "件");
      bar.appendChild(tip);
      wrap.appendChild(bar);
    }
  }

  function selTable(rows, head) {
    var t = el("table");
    var tr = el("tr");
    for (var i = 0; i < head.length; i++) tr.append(el("th", "", head[i]));
    t.appendChild(tr);
    return t;
  }

  function td(v, cls) { return el("td", cls, v); }

  function sMsg(text, isError) {
    var m = $("smsg");
    m.textContent = text;
    m.style.color = isError ? "#b3261e" : "";
  }

  var SEARCH_HEAD = ["ID", "商品", "評価", "匿名ID", "状態", "通報", "本文", "日時", "操作"];

  function renderSearch(d) {
    var wrap = $("sresults");
    wrap.textContent = "";
    if (!d.reviews || d.reviews.length === 0) {
      wrap.append(el("div", "muted", "該当するレビューはありません"));
      return;
    }
    wrap.append(el("div", "muted", d.reviews.length + " 件 / 全 " + d.total + " 件"));
    var t = el("table");
    var tr = el("tr");
    for (var i = 0; i < SEARCH_HEAD.length; i++) tr.append(el("th", "", SEARCH_HEAD[i]));
    t.appendChild(tr);
    for (var k = 0; k < d.reviews.length; k++) {
      var r = d.reviews[k];
      var row = el("tr");
      var st = el("span", "badge " + r.status, statusName(r.status));
      var stTd = td("");
      stTd.appendChild(st);
      // 操作: 削除 (公開/非表示→削除) / 復活 (削除→公開) / 非表示
      var act = el("td");
      if (r.status !== "deleted") {
        var del = el("button", "ghost", "削除");
        del.addEventListener("click", adminPatch(r.id, "deleted"));
        act.appendChild(del);
        var hide = el("button", "ghost", r.status === "hidden" ? "公開に戻す" : "非表示");
        hide.style.marginLeft = "4px";
        hide.addEventListener("click", adminPatch(r.id, r.status === "hidden" ? "published" : "hidden"));
        act.appendChild(hide);
      } else {
        var restore = el("button", "ghost", "公開に戻す");
        restore.addEventListener("click", adminPatch(r.id, "published"));
        act.appendChild(restore);
      }
      // この匿名ID自体を投稿禁止にする (解除は下の BAN リストから)
      var ban = el("button", "ghost", "禁止");
      ban.style.marginLeft = "4px";
      ban.addEventListener("click", adminBan(r.id, r.author));
      act.appendChild(ban);
      var link = el("a", "", String(r.itemId));
      link.href = "https://booth.pm/ja/items/" + r.itemId;
      link.target = "_blank";
      link.rel = "noopener";
      var itemTd = td("");
      itemTd.appendChild(link);
      row.append(
        td(String(r.id)),
        itemTd,
        td("★".repeat(r.rating)),
        td(r.author, "anonid"),
        stTd,
        td(String(r.reportCount)),
        td(r.body, "clip"),
        td(r.updatedAt.slice(0, 16).replace("T", " ")),
        act
      );
      t.appendChild(row);
    }
    wrap.appendChild(t);
  }

  function adminPatch(id, status) {
    return function () {
      if (!confirm("レビュー #" + id + " を「" + statusName(status) + "」にしますか?")) return;
      fetch("/v1/admin/reviews/" + id, {
        method: "PATCH",
        headers: { authorization: "Bearer " + sessionStorage.getItem(KEY), "content-type": "application/json" },
        body: JSON.stringify({ status: status })
      })
        .then(function (res) {
          if (res.status === 401) throw new Error("トークンが違います");
          if (!res.ok) throw new Error("HTTP " + res.status);
          sMsg("レビュー #" + id + " を " + statusName(status) + " にしました");
          runSearch(true);
        })
        .catch(function (e) { sMsg("更新に失敗: " + e.message, true); });
    };
  }

  // レビュー行の「禁止」: その匿名IDを投稿禁止に登録する
  function adminBan(id, author) {
    return function () {
      if (!confirm("匿名ID " + author + "… を投稿禁止にしますか?\\n(この匿名IDからの投稿・編集・通報がすべて 403 になります)")) return;
      fetch("/v1/admin/blocks", {
        method: "POST",
        headers: { authorization: "Bearer " + sessionStorage.getItem(KEY), "content-type": "application/json" },
        body: JSON.stringify({ reviewId: id })
      })
        .then(function (res) {
          if (res.status === 401) throw new Error("トークンが違います");
          if (!res.ok) throw new Error("HTTP " + res.status);
          sMsg("匿名ID " + author + "… を投稿禁止にしました (レビュー #" + id + " 経由)");
          return loadBlocks();
        })
        .catch(function (e) { sMsg("禁止に失敗: " + e.message, true); });
    };
  }

  function loadBlocks() {
    var t = sessionStorage.getItem(KEY);
    if (!t) return Promise.resolve();
    return fetch("/v1/admin/blocks", { headers: { authorization: "Bearer " + t } })
      .then(function (res) {
        if (res.status === 401) throw new Error("トークンが違います");
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(renderBlocks)
      .catch(function (e) {
        var wrap = $("blocks");
        wrap.textContent = "";
        wrap.append(el("div", "muted", "BAN リストの取得に失敗: " + e.message));
      });
  }

  function renderBlocks(d) {
    var wrap = $("blocks");
    wrap.textContent = "";
    if (d.total === 0) { wrap.append(el("div", "muted", "投稿禁止はありません")); return; }
    var t = el("table");
    var tr = el("tr");
    ["匿名ID", "理由", "登録日時", "操作"].forEach(function (h) { tr.append(el("th", "", h)); });
    t.appendChild(tr);
    d.blocks.forEach(function (b) {
      var row = el("tr");
      var act = el("td");
      if (b.sampleReviewId !== null) {
        var un = el("button", "ghost", "解除");
        un.addEventListener("click", function () {
          if (!confirm("匿名ID " + b.author + "… の投稿禁止を解除しますか?")) return;
          fetch("/v1/admin/blocks/" + b.sampleReviewId, {
            method: "DELETE",
            headers: { authorization: "Bearer " + sessionStorage.getItem(KEY) }
          })
            .then(function (res) {
              if (res.status === 401) throw new Error("トークンが違います");
              if (!res.ok) throw new Error("HTTP " + res.status);
              sMsg("匿名ID " + b.author + "… の投稿禁止を解除しました");
              return loadBlocks();
            })
            .catch(function (e) { sMsg("解除に失敗: " + e.message, true); });
        });
        act.appendChild(un);
      } else {
        act.append(el("span", "muted", "解除不可 (レビューが無い)"));
      }
      row.append(
        td(b.author, "anonid"),
        td(b.reason === null ? "―" : b.reason),
        td(b.createdAt.slice(0, 16).replace("T", " ")),
        act
      );
      t.appendChild(row);
    });
    wrap.appendChild(t);
  }

  function runSearch(silent) {
    var t = sessionStorage.getItem(KEY);
    if (!t) { showLogin(); return; }
    var qs = [];
    var q = $("sq").value.trim();
    var anon = $("sanon").value.trim();
    if (q) qs.push("query=" + encodeURIComponent(q));
    if (anon) qs.push("anonId=" + encodeURIComponent(anon));
    if (qs.length === 0) {
      if (!silent) sMsg("本文か匿名IDを入力してください", true);
      return;
    }
    if (!silent) sMsg("検索中…");
    fetch("/v1/admin/reviews?" + qs.join("&"), { headers: { authorization: "Bearer " + t } })
      .then(function (res) {
        if (res.status === 401) throw new Error("トークンが違います (ADMIN_TOKEN)");
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error(j && j.error ? j.error.message : "HTTP " + res.status);
          });
        }
        return res.json();
      })
      .then(function (d) {
        sMsg(qs.length + " 件の条件で " + d.total + " 件ヒット");
        renderSearch(d);
      })
      .catch(function (e) { sMsg("検索に失敗: " + e.message, true); });
  }

  $("sbtn").addEventListener("click", function () { runSearch(false); });
  $("sanon").addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(false); });
  $("sq").addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(false); });

  function renderReported(d) {
    var wrap = $("reported"); wrap.textContent = "";
    if (d.topReported.length === 0) { wrap.append(el("div", "muted", "通報はありません")); return; }
    var t = selTable(d.topReported, ["ID", "商品", "評価", "本文", "状態", "通報", "日時"]);
    for (var i = 0; i < d.topReported.length; i++) {
      var r = d.topReported[i];
      var tr = el("tr");
      var st = el("span", "badge " + r.status, statusName(r.status));
      tr.append(
        td(String(r.id)),
        td(String(r.itemId)),
        td("★".repeat(r.rating)),
        td(r.body, "clip"),
        (function () { var x = td(""); x.appendChild(st); return x; })(),
        td(String(r.reportCount)),
        td(r.createdAt.slice(0, 16).replace("T", " "))
      );
      t.appendChild(tr);
    }
    wrap.appendChild(t);
  }

  function renderItems(d) {
    var wrap = $("items"); wrap.textContent = "";
    if (d.topItems.length === 0) { wrap.append(el("div", "muted", "公開レビューがありません")); return; }
    var t = selTable([], ["アイテムID", "レビュー数"]);
    for (var i = 0; i < d.topItems.length; i++) {
      var item = d.topItems[i];
      var tr = el("tr");
      var a = el("a", "", String(item.itemId));
      a.href = "https://booth.pm/ja/items/" + item.itemId;
      a.target = "_blank";
      a.rel = "noopener";
      var ac = td(""); ac.appendChild(a); tr.append(ac, td(String(item.count)));
      t.appendChild(tr);
    }
    wrap.appendChild(t);
  }

  function renderServer(d) {
    var wrap = $("server"); wrap.textContent = "";
    var t = selTable([], ["項目", "値"]);
    var rows = [];
    rows.push(["DB サイズ", fmtBytes(d.dbSizeBytes)]);
    for (var i = 0; i < d.tableSizes.length; i++) rows.push(["テーブル " + d.tableSizes[i].table, fmtBytes(d.tableSizes[i].bytes)]);
    if (d.disk) rows.push(["ディスク合計", fmtBytes(d.disk.totalBytes)], ["ディスク空き", fmtBytes(d.disk.freeBytes)]);
    else rows.push(["ディスク合計", "取得不可"]);
    for (var b = 0; b < d.backups.length && b < 10; b++) rows.push(["バックアップ " + d.backups[b].file, fmtBytes(d.backups[b].bytes)]);
    if (d.backups.length === 0) rows.push(["バックアップ", "まだありません"]);
    for (var k = 0; k < rows.length; k++) {
      var tr = el("tr"); tr.append(td(rows[k][0]), td(rows[k][1])); t.appendChild(tr);
    }
    wrap.appendChild(t);
  }

  function render(d) {
    renderCards(d); renderDist(d); renderTrend(d); renderReported(d); renderItems(d); renderServer(d);
    loadBlocks();
    $("at").textContent = new Date().toLocaleString() + " 取得";
  }

  function load(token) {
    return fetch("/v1/admin/stats", { headers: { authorization: "Bearer " + token } })
      .then(function (res) {
        if (res.status === 401) throw new Error("トークンが違います (ADMIN_TOKEN)");
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
  }

  function showLogin(msg) {
    $("app").style.display = "none";
    $("error").hidden = true;
    $("login").hidden = false;
    if (msg) $("login").querySelector("p.muted").textContent = msg;
  }

  function boot(token, msg) {
    $("login").hidden = true;
    $("app").hidden = false;
    $("app").style.display = "";
    load(token)
      .then(function (d) {
        sessionStorage.setItem(KEY, token);
        render(d);
      })
      .catch(function (e) {
        showLogin(e.message);
      });
  }

  $("loginBtn").addEventListener("click", function () { boot($("token").value); });
  $("token").addEventListener("keydown", function (e) { if (e.key === "Enter") boot($("token").value); });
  $("reload").addEventListener("click", function () {
    var t = sessionStorage.getItem(KEY);
    if (t) load(t).then(render).catch(function (e) { showLogin(e.message); });
  });

  var saved = sessionStorage.getItem(KEY);
  if (saved) boot(saved); else showLogin();
})();
</script>
</body>
</html>`;

/**
 * プライバシーポリシー (公開静的ページ)。
 * - 外部スクリプト/字体/画像なし・リンクのみ。XSS 要素は持たない (本文は全て静的固定文字列)
 */
const PRIVACY_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOOTHReview プライバシーポリシー</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #222; font-size: 14px; line-height: 1.7; }
  header { background: #173a5e; color: #fff; padding: 14px 20px; }
  header h1 { font-size: 16px; margin: 0; }
  main { max-width: 760px; margin: 0 auto; padding: 20px 16px 48px; }
  section { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; }
  h2 { font-size: 14px; margin: 0 0 8px; color: #173a5e; }
  ul, p { margin: 6px 0; }
  li { margin: 2px 0; }
  code { background: #eef0f3; border-radius: 4px; padding: 0 4px; font-size: 12.5px; }
  .muted { color: #6b7280; font-size: 12px; }
  a { color: #0074c8; }
</style>
</head>
<body>
<header><h1>BOOTHReview プライバシーポリシー</h1></header>
<main>
  <p>本ページは、BOOTH (booth.pm) の商品ページ上に第三者レビューを表示・投稿できるブラウザ拡張「BOOTHReview」が通信するバックエンド (<code>reviews.luxdum.win</code>) の取扱いを説明します。</p>

  <section><h2>1. 扱う情報の範囲</h2>
    <ul>
      <li>本サービスは BOOTH とは無関係な、個人が運営する第三者レビューです。BOOTH 本体 (booth.pm) とは一切通信せず、BOOTH の商品情報を取得・保存しません (扱うのは商品/ショップの ID・サブドメインだけ)。</li>
      <li>ログイン機能はなく、メールアドレスや氏名、SNS アカウント等の個人を特定できる情報は扱いません。</li>
    </ul>
  </section>

  <section><h2>2. 保存する情報</h2>
    <ul>
      <li><strong>匿名IDのハッシュ値</strong> (拡張内で生成したランダム UUID を pepper 付き HMAC-SHA256 でハッシュした値)。元の UUID は保存せず、ハッシュのみで本人性の照合・重複判定を行います。</li>
      <li><strong>レビュー内容</strong>: 5段階評価 (1〜5)・本文。投稿日時 (UTC)。</li>
      <li><strong>ショップのサブドメイン</strong>: 投稿元 URL から採取した <code>xxx.booth.pm</code> のサブドメイン (ショップ単位の集計に使用)。</li>
      <li><strong>通報の記録</strong>: 通報されたレビューと通報者の匿名IDハッシュ (重複通報の判定のみに使用)。</li>
    </ul>
  </section>

  <section><h2>3. 取得・保存しないもの</h2>
    <ul>
      <li><strong>IPアドレス</strong>: 悪用防止 (レート制限) のためにメモリ上で一時的に参照するのみで、データベースやログには保存しません。</li>
      <li>匿名IDの元値 (UUID)・個人を特定できる情報・BOOTH のログイン情報や Cookie。</li>
      <li>デバッグ用ログにも IP やレビュー本文は出力しません (メソッド・パス・ステータス・処理時間のみ)。</li>
    </ul>
  </section>

  <section><h2>4. 外部サービス</h2>
    <ul>
      <li>本サービスへの通信は Cloudflare (Tunnel / CDN) 経由で受けています。Cloudflare 側ではこれらの技術情報の処理が行われます (詳細は Cloudflare のプライバシーポリシーをご参照ください)。</li>
    </ul>
  </section>

  <section><h2>5. 削除・非表示・投稿禁止</h2>
    <ul>
      <li>自分のレビューは、投稿に使用した端末 (匿名ID) からいつでも拡張内から削除できます。</li>
      <li>他の利用者からの通報が一定数に達したレビューは自動で非表示になり、管理者が確認します。</li>
      <li>悪質な投稿者に対しては、匿名IDのハッシュ単位で「投稿禁止 (BAN)」を登録することがあります (新規投稿・編集・通報ができなくなります)。解除の問い合わせは下記の連絡先へ。</li>
      <li>削除済みのレビューは論理削除のためデータベースと日次バックアップ内に一定期間残ります。</li>
    </ul>
  </section>

  <section><h2>6. お問い合わせ</h2>
    <ul>
      <li>GitHub Issues: <a href="https://github.com/LUXDUM/BoothReview/issues" rel="noopener">https://github.com/LUXDUM/BoothReview/issues</a></li>
      <li>ソースコードは公開しています (サーバー: <a href="https://github.com/LUXDUM/BoothReview" rel="noopener">LUXDUM/BoothReview</a> / 拡張: <a href="https://github.com/LUXDUM/BoothReviewExtension" rel="noopener">LUXDUM/BoothReviewExtension</a>)。</li>
    </ul>
  </section>

  <p class="muted">最終更新: 2026-10-24</p>
</main>
</body>
</html>`;
