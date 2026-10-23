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

// ---- ショップページ (例: https://nico25.booth.pm/) ----

/**
 * BOOTH ショップのサブドメインを抽出する (例: nico25.booth.pm → "nico25")。
 * www.booth.pm はショップではない。アイテムページでもサブドメインはショップ名なので
 * 投稿時の紐付け (POST /items/:id/reviews の shop) にそのまま使える。
 */
export function extractShopFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.endsWith("booth.pm")) return null;
  const suffix = ".booth.pm";
  const sub = u.hostname.slice(0, -suffix.length);
  if (!sub || sub.includes(".") || sub === "www") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) return null;
  return sub;
}

/** ショップトップページ判定 (/items/ を含まないショップサブドメインのページ) */
export function isShopPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return extractShopFromUrl(url) !== null && !ITEM_PATH_RE.test(u.pathname);
}

/**
 * レビュー一覧を差し込む「ページ最下部の境界」アンカー。商品・ショップ両ページで共通。
 * 挿入は attachPanelHost の「anchor の直前」に行われる。
 * - できれば「フォロー中ショップの提案」ブロックの前
 * - 見つからなければ BOOTH のフッターの直前 (= ページ最下部)
 *   ※ 商品ページ (booth.pm/items/…) にも FOOTER.footer__menu がある (実機確認済み)
 */
const BOTTOM_MOUNT_ANCHOR_SELECTORS: readonly string[] = [
  ".js-recommend-shops",
  "#js-recommend-shops",
  ".shop-follow-section",
  // フォールバック: BOOTH のフッター
  "#shop_default .page-wrap footer",
  "footer",
];

export function findBottomMountAnchor(doc: Document): Element | null {
  for (const sel of BOTTOM_MOUNT_ANCHOR_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 後方互換のための別名 (旧実装の名前がテスト・将来コードで使われる可能性に備える) */
export const findShopMountAnchor = findBottomMountAnchor;

/**
 * 「全体評価 ☆バッジ」を置く一番上のアンカー (ショップページ)。
 * メインコンテンツ (商品一覧) の直前 = ショップヘッダー (名前等) の直下に来る。
 */
const SHOP_BADGE_ANCHOR_SELECTORS: readonly string[] = [
  "#shop_default .page-wrap .layout-wrap main",
  "#shop_default main",
];

export function findShopBadgeAnchor(doc: Document): Element | null {
  for (const sel of SHOP_BADGE_ANCHOR_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * 商品ページの☆チップを置くアンカー: ショップ名の横のカート円ボタン。
 * 実機 2026-11: 右カラムのショップ行は div.flex の中に
 *   a[data-product-list="…to shop_index"] (アバター+ショップ名) と
 *   a[title="カート"][href*=".booth.pm/cart"] (pixiv-icon Basket の円ボタン) が並ぶ。
 * ※ ページ下部の「おすすめショップ」カードにも .shop-card__shop-name があるため、
 *   そのクラスを直接探すと誤配置する → カート円ボタンを最優先で探す。
 */
export function findItemBadgeAnchor(doc: Document): Element | null {
  return doc.querySelector("a[href$='.booth.pm/cart']");
}

/** Magic DOM 中へ挿入するパネルホスト要素を作る */
export function createPanelHostId(): string {
  return "boothreview-panel-host";
}

/** ショップページの「全体評価 ☆バッジ」用ホストID */
export function createBadgeHostId(): string {
  return "boothreview-badge-host";
}

/** バッジホストの取得/生成 (hosts は既存があれば再利用) */
function ensureBadgeHost(doc: Document): HTMLElement {
  const hostId = createBadgeHostId();
  let host = doc.getElementById(hostId);
  if (!host) {
    host = doc.createElement("div");
    host.id = hostId;
    for (const [prop, value] of Object.entries(PANEL_HOST_ID_STYLES)) {
      host.style.setProperty(propToKebab(prop), value);
    }
  }
  return host;
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

/** ショップページの☆バッジ用ホスト (パネルホストと別にする。バッジは先に消えないよう常設) */
export function attachBadgeHost(doc: Document, anchor: Element): HTMLElement {
  const host = ensureBadgeHost(doc);
  if (!host.parentElement && anchor.parentElement) {
    anchor.parentElement.insertBefore(host, anchor);
  }
  return host;
}

/**
 * 商品ページの☆チップ用ホスト: anchor (ショップ名) の「直後」に挿入。
 * ショップ名の横に並べるため inline-flex + 左余白を付ける。
 */
export function attachBadgeHostAfter(doc: Document, anchor: Element): HTMLElement {
  const host = ensureBadgeHost(doc);
  if (anchor.parentElement) {
    if (!host.parentElement || host.parentElement !== anchor.parentElement ||
        host.previousElementSibling !== anchor) {
      if (anchor.nextSibling) {
        anchor.parentElement.insertBefore(host, anchor.nextSibling);
      } else {
        anchor.parentElement.appendChild(host);
      }
    }
  }
  const ds = host.style;
  ds.display = "inline-flex";
  ds.alignItems = "center";
  ds.flexShrink = "0";
  ds.marginLeft = "4px";
  return host;
}

function propToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
