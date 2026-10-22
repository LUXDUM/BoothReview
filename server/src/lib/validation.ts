import { z } from "zod";

/**
 * 入力値のバリデーション・サニタイズ。
 * 仕様 5.3: 型・範囲・文字数・制御文字の除去をサーバー側で厳密に行う。
 */

/** 目に見えない文字・制御文字(TAB/CR/LF以外)とゼロ幅文字を除去する */
const INVISIBLE_AND_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;

export function sanitizeBody(input: string): string {
  return input.normalize("NFC").replace(INVISIBLE_AND_CONTROL, "").trim();
}

/**
 * レビュー本文: プレーンテキスト。文字数は .env の MIN/MAX_BODY_LEN 配下。
 * 改行(\n)は許可する。行末のCRは正規化する。
 */
export function createBodySchema(config: {
  minBodyLen: number;
  maxBodyLen: number;
}) {
  return z
    .string({
      errorMap: () => ({ message: "body must be a string" }),
    })
    .transform(sanitizeBody)
    .pipe(
      z
        .string()
        .min(config.minBodyLen, {
          message: `body must be at least ${config.minBodyLen} characters`,
        })
        .max(config.maxBodyLen, {
          message: `body must be at most ${config.maxBodyLen} characters`,
        }),
    );
}

export const ratingSchema = z
  .number({ invalid_type_error: "rating must be a number" })
  .int("rating must be an integer")
  .min(1, "rating must be between 1 and 5")
  .max(5, "rating must be between 1 and 5");

/** 匿名UUID。拡張が生成する (crypto.randomUUID) 形式のみ受け付ける */
export const anonIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "anon id must be a UUID",
  );

export const itemIdSchema = z.coerce
  .number()
  .int("item id must be an integer")
  .positive("item id must be positive")
  .max(9_999_999_999, "item id is too large");

export const pageSchema = z.coerce.number().int().positive().default(1);

export function createPerPageSchema(config: {
  perPageDefault: number;
  perPageMax: number;
}) {
  return z.coerce
    .number()
    .int()
    .positive()
    .max(config.perPageMax, `perPage must be at most ${config.perPageMax}`)
    .default(config.perPageDefault);
}

export const adminStatusSchema = z.enum(["published", "hidden", "deleted"]);

/**
 * BOOTH ショップのサブドメイン (例: nico25.booth.pm → "nico25")。
 * 投稿時にURLから採取してレビューに付与し、ショップページでの集計に使う。
 */
export const shopSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "shop must be a BOOTH subdomain (lowercase alnum and hyphens)",
  );
