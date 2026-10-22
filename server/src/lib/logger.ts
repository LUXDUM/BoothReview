/**
 * 構造化ロガーの最小インターフェース。
 * 実装は pino (本番) 、または console ラッパ (テスト) を渡す。
 */
export type Logger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
};
