import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
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
} from "../lib/validation.js";
import { authorHash } from "../lib/hash.js";
import { extractClientIp } from "../lib/ip.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

export type AppDeps = {
  config: Config;
  repo: ReviewRepository;
  limiter: RateLimiter;
  logger: Logger;
};

type PublicReview = {
  id: number;
  rating: number;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 公開レスポンス。匿名IDやそのハッシュは、いかなるエンドポイントでも返さない。
 */
function toPublic(r: ReviewRecord): PublicReview {
  return {
    id: r.id,
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
    return c.json({ review: review ? toPublic(review) : null });
  });

  app.post("/v1/items/:itemId/reviews", async (c) => {
    const itemId = await numericParam(c, "itemId");
    limitOrThrow(
      ipBucketKey("post", c),
      config.rateLimits.postPerIpPerHour,
      HOUR_MS,
    );
    const input = parseWith(
      z.object({ rating: ratingSchema, body: bodySchema, anonId: anonIdSchema }),
      await readJson(c),
    );
    const hash = authorHash(config.pepper, input.anonId);
    limitOrThrow(
      `post:anon:${hash}`,
      config.rateLimits.postPerAnonPerHour,
      HOUR_MS,
    );

    const { review, created } = await repo.upsertReview({
      itemId,
      authorHashHex: hash,
      rating: input.rating,
      body: input.body,
    });
    return c.json({ review: toPublic(review), created }, created ? 201 : 200);
  });

  app.patch("/v1/reviews/:id", async (c) => {
    const id = await numericParam(c, "id");
    const anonId = requireAnonHeader(c);
    const hash = authorHash(config.pepper, anonId);
    const input = parseWith(
      z
        .object({ rating: ratingSchema.optional(), body: bodySchema.optional() })
        .refine(
          (v) => v.rating !== undefined || v.body !== undefined,
          { message: "at least one of rating or body is required" },
        ),
      await readJson(c),
    );
    const res = await repo.updateOwnReview(id, hash, {
      rating: input.rating,
      body: input.body,
    });
    if (!res.found) throw Errors.notFound();
    if (!res.owned) throw Errors.forbidden();
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

  app.get("/v1/admin/reviews", async (c) => {
    const statusParam = asReq(c).req.query("status");
    const status: ReviewStatus | undefined = statusParam
      ? parseWith(adminStatusSchema, statusParam)
      : undefined;
    const itemIdRaw = asReq(c).req.query("itemId");
    const itemId = itemIdRaw ? parseWith(itemIdSchema, itemIdRaw) : undefined;
    const page = parseWith(pageSchema, asReq(c).req.query("page") ?? "1");
    const perPage = parseWith(
      perPageSchema,
      asReq(c).req.query("perPage") ?? String(config.perPageDefault),
    );
    const { items, total } = await repo.adminListReviews({ status, itemId, page, perPage });
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

  return app;
}
