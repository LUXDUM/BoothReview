import { API_ORIGIN } from "../src/shared/config";
import type { ApiRequestMessage, ApiResponseMessage } from "../src/shared/types";

/**
 * Service Worker (background)。
 * Content Script から fetch を切り離すためのプロキシのみを担う。
 * (ページの CSP / CORS の影響を受けないようにするため)
 *
 * API 以外の通信は一切行わない。BOOTH 本体にも送信しない。
 */

declare const defineBackground: (cb: () => void) => unknown;

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse): boolean => {
      if (typeof message !== "object" || message === null) return false;
      const msg = message as Partial<ApiRequestMessage>;
      if (msg.type !== "api-request" || typeof msg.requestId !== "string") return false;

      handleApiRequest(msg as ApiRequestMessage)
        .then((response: ApiResponseMessage) => sendResponse(response))
        .catch(() => {
          sendResponse({
            type: "api-response",
            requestId: msg.requestId,
            ok: false,
            status: 0,
            data: null,
            networkError: true,
            error: "background handler failed",
          });
        });
      return true; // sendResponse は非同期
    },
  );
});

async function handleApiRequest(msg: ApiRequestMessage): Promise<ApiResponseMessage> {
  const requestId = msg.requestId;
  let url: URL;
  try {
    url = new URL(msg.path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) {
      // API オリジン以外へのリクエストは開いていない
      return {
        type: "api-response",
        requestId,
        ok: false,
        status: 0,
        data: null,
        networkError: true,
        error: "disallowed origin",
      };
    }
  } catch {
    return {
      type: "api-response",
      requestId,
      ok: false,
      status: 0,
      data: null,
      networkError: true,
      error: "invalid path",
    };
  }

  const headers: Record<string, string> = {};
  if (typeof msg.anonId === "string" && msg.anonId) {
    headers["x-anon-id"] = msg.anonId;
  }
  if (msg.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  try {
    const res = await fetch(url, {
      method: msg.method,
      headers,
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
      // 名刺: 公開 GET のキャッシュは max-age=60 とヘッダー指定でブラウザに任せる
      // (Service Worker fetch では既定のキャシュ挙動を明示したいので no-cache)
      cache: "no-cache",
      mode: "cors",
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = text;
      }
    }
    return { type: "api-response", requestId, ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      type: "api-response",
      requestId,
      ok: false,
      status: 0,
      data: null,
      networkError: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
