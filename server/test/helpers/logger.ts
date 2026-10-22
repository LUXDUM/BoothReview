import type { Logger } from "../../src/lib/logger.js";

/** テスト用のサイレントロガー */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
