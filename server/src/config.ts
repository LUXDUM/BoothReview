import { z } from "zod";

/**
 * すべての実行時設定は環境変数から読む (.env / docker-compose env_file)。
 * ここで Representative なパース・デフォルト値を閉じ込める。
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (s) => s.startsWith("postgres://") || s.startsWith("postgresql://"),
      { message: "DATABASE_URL must be a postgres:// URL" },
    ),
  /**
   * 匿名IDをハッシュ化するためのサーバー側秘密値 (pepper)。
   * にもかかわらず匿名IDやそのハッシュはどのAPIレスポンスにも返さない。
   */
  PEPPER: z.string().min(16),
  ADMIN_TOKEN: z.string().min(16),
  /**
   * CORSで許可するオリジン(カンマ区切り)。
   * 拡張機能からの通信は Service Worker +(host_permissions) で行い CORS は不要。
   * 将来の公開Webサイト向けに空でない値を設定できる。空配列 = CORSヘッダなし。
   */
  CORS_ORIGINS: z.string().default(""),
  /**
   * CF-Connecting-IP を信頼してクライアントIPとして扱うリクエスト元アドレス(CIDR)。
   * docker-compose 内では cloudflared が内部ネットワーク経由で到達する。
   * 同一ネットワークのアドレス以外から来た CF-Connecting-IP は偽装の可能性があるため使わない。
   */
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.1/32,::1/128,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"),
  MIN_BODY_LEN: z.coerce.number().int().positive().default(10),
  MAX_BODY_LEN: z.coerce.number().int().positive().max(2000).default(2000),
  // 一定数以上の通報で自動非表示になる閾値
  REPORT_AUTOHIDE_THRESHOLD: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_POST_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_POST_PER_ANON_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REPORT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REPORT_PER_ANON_PER_HOUR: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LIST_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MINE_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(30),
  PER_PAGE_DEFAULT: z.coerce.number().int().positive().default(10),
  PER_PAGE_MAX: z.coerce.number().int().positive().default(50),
  CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(60),
});

export type Env = z.infer<typeof envSchema>;

export type Config = {
  env: Env["NODE_ENV"];
  port: number;
  databaseUrl: string;
  pepper: string;
  adminToken: string;
  corsOrigins: string[];
  trustedProxyCidrs: string[];
  minBodyLen: number;
  maxBodyLen: number;
  reportAutoHideThreshold: number;
  rateLimits: {
    postPerIpPerHour: number;
    postPerAnonPerHour: number;
    reportPerIpPerHour: number;
    reportPerAnonPerHour: number;
    listPerIpPerMinute: number;
    minePerIpPerMinute: number;
  };
  perPageDefault: number;
  perPageMax: number;
  cacheMaxAgeSeconds: number;
};

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    pepper: e.PEPPER,
    adminToken: e.ADMIN_TOKEN,
    corsOrigins: e.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDRS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    minBodyLen: e.MIN_BODY_LEN,
    maxBodyLen: e.MAX_BODY_LEN,
    reportAutoHideThreshold: e.REPORT_AUTOHIDE_THRESHOLD,
    rateLimits: {
      postPerIpPerHour: e.RATE_LIMIT_POST_PER_IP_PER_HOUR,
      postPerAnonPerHour: e.RATE_LIMIT_POST_PER_ANON_PER_HOUR,
      reportPerIpPerHour: e.RATE_LIMIT_REPORT_PER_IP_PER_HOUR,
      reportPerAnonPerHour: e.RATE_LIMIT_REPORT_PER_ANON_PER_HOUR,
      listPerIpPerMinute: e.RATE_LIMIT_LIST_PER_IP_PER_MINUTE,
      minePerIpPerMinute: e.RATE_LIMIT_MINE_PER_IP_PER_MINUTE,
    },
    perPageDefault: e.PER_PAGE_DEFAULT,
    perPageMax: e.PER_PAGE_MAX,
    cacheMaxAgeSeconds: e.CACHE_MAX_AGE_SECONDS,
  };
}

export const DEFAULT_SERVICE = "boothreview-server";
