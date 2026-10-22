/**
 * BOOTH 商品ページの DOM / URL 操作はすべてこのモジュールに集約する。
 *
 * 制限事項: BOOTH 側の仕様変更で壊れやすい箇所 (セレクタ・URLパターン) を
 * ここに置くため、変更はこのファイルだけで完結する。
 */

/** 商品ページ URL パターン (実機確認推奨: README 参照)。
 *  booth.pm 直 (/items/123 や /ja/items/123) とショップサブドメイン両方に対応。
 */
const ITEM_PATH_RE = /\/items\/(\d+)/;

/** 商品ID抽出 (純粋関数)。商品ページでなければ null */
export function extractItemIdFromUrl(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.endsWith("booth.pm")) return null;
  const m = ITEM_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * レビューパネルを差し込むアンカー要素を探す。
 * セレクタをここにまとめ、BOOTH の仕様変更時はこのリストを更新する。
 */
const MOUNT_ANCHOR_SELECTORS: readonly string[] = [
  // 商品詳細 ypnn 見つけやすい順に足していく
  "#content",
  "main",
  "[data-id='item-detail']",
  ".market-item-detail-item",
];

export function findMountAnchor(doc: Document): Element | null {
  for (const sel of MOUNT_ANCHOR_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Magic DOM 中へ挿入するパネルホスト要素を作る */
export function createPanelHostId(): string {
  return "boothreview-panel-host";
}

const PANEL_HOST_ID_STYLES = {
  all: "unset",
  display: "block",
} as const;

export function attachPanelHost(doc: Document, anchor: Element): HTMLElement {
  const hostId = createPanelHostId();
  let host = doc.getElementById(hostId);
  if (!host) {
    host = doc.createElement("div");
    host.id = hostId;
    // BOOTH 側 CSS の干渉を避けるため inline で最小限のスタイルのみ
    for (const [prop, value] of Object.entries(PANEL_HOST_ID_STYLES)) {
      host.style.setProperty(propToKebab(prop), value);
    }
    if (anchor.parentElement) {
      anchor.parentElement.insertBefore(host, anchor);
    } else {
      doc.body.appendChild(host);
    }
  }
  return host;
}

function propToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
