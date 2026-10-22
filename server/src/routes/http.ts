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
      shop: input.shop,
    });
    return c.json({ review: toPublic(review), created }, created ? 201 : 200);
  });

  app.patch("/v1/reviews/:id", async (c) => {
    const id = await numericParam(c, "id");
    const anonId = requireAnonHeader(c);
    const hash = authorHash(config.pepper, anonId);
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
    const res = await repo.updateOwnReview(id, hash, {
      rating: input.rating,
      body: input.body,
      shop: input.shop,
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
