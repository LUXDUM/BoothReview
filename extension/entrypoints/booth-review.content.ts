import {
  extractItemIdFromUrl,
  extractShopFromUrl,
  findMountAnchor,
  findShopBadgeAnchor,
  findBottomMountAnchor,
  attachPanelHost,
  attachBadgeHost,
  isShopPage,
} from "../src/core/booth-dom";
import { getOrCreateAnonId } from "../src/core/anon-id";
import { mountPanel, mountBadge, type PanelHandle } from "../src/ui/panel";
import { API_ORIGIN } from "../src/shared/config";

/**
 * BOOTH 商品ページ / ショップページにレビューUIを差し込む content script。
 *
 * - 対象 URL は patterns で粗く受けて、商品ID・ショップ抽出 (core/booth-dom.ts) で厳密に判定する
 * - 商品ページ: 従来どおりパネル (一覧 + 投稿フォーム) を差し込む
 * - ショップページ: 最上部に「全体評価 ☆バッジ」(押すと最下までスクロール)、
 *   最下部にレビュー一覧 (通報のみ・投稿は商品ページから) を差し込む
 * - BOOTH は SPA 遷移の可能性があるため MutationObserver + ポーリングで監視する
 */

declare const defineContentScript: (args: {
  matches: string[];
  runAt?: "document_start" | "document_end" | "document_idle";
  main: () => void;
}) => unknown;

export default defineContentScript({
  matches: ["*://*.booth.pm/*"],
  runAt: "document_idle",
  main: () => {
    console.info("[BoothReview] content script loaded, API:", API_ORIGIN);
    /** 現在マウント中の対象 ("items:123" / "shop:sub") */
    let mountedTarget: string | null = null;
    let panel: PanelHandle | null = null;
    let badge: PanelHandle | null = null;

    function mountItem(itemId: number): void {
      // ☆バッジ (商品ページも上部に配置。押すと下までスクロール)
      const badgeAnchor = findMountAnchor(document);
      if (badgeAnchor) {
        const badgeHost = attachBadgeHost(document, badgeAnchor);
        const badgeRoot = badgeHost.shadowRoot ?? badgeHost.attachShadow({ mode: "open" });
        badge = mountBadge({ shadowRoot: badgeRoot, target: { kind: "item", itemId } });
      }
      // レビュー一覧 + 投稿フォーム (ページ最下部)。フッターが見つからない場合は従来の上部位置へ
      const anchor = findBottomMountAnchor(document) ?? findMountAnchor(document);
      if (!anchor) return; // BOOTH 側 DOM の読み込み待ち (observer が再試行する)
      const host = attachPanelHost(document, anchor);
      // すでに Shadow DOM がある場合 (BOOTH 側再描画でノードだけ消された等) は再利用
      const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      panel = mountPanel({
        shadowRoot,
        itemId,
        getAnonId: () => getOrCreateAnonId(),
        getShop: () => extractShopFromUrl(location.href),
      });
      mountedTarget = `items:${itemId}`;
    }

    function mountShop(shop: string): void {
      // ☆バッジ (押すと下までスクロール)
      const badgeAnchor = findShopBadgeAnchor(document);
      if (badgeAnchor) {
        const badgeHost = attachBadgeHost(document, badgeAnchor);
        const badgeRoot = badgeHost.shadowRoot ?? badgeHost.attachShadow({ mode: "open" });
        badge = mountBadge({ shadowRoot: badgeRoot, target: { kind: "shop", shop } });
      }
      // レビュー一覧 (投稿は商品ページから)
      const anchor = findBottomMountAnchor(document);
      if (!anchor) return; // アンカー未検出 → observer/ポーリングが再試行する (mountedTarget は未設定)
      const host = attachPanelHost(document, anchor);
      const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      panel = mountPanel({
        shadowRoot,
        itemId: 0,
        getAnonId: () => getOrCreateAnonId(),
        mode: "shop",
        shop,
      });
      mountedTarget = `shop:${shop}`;
    }

    function unmount(): void {
      panel?.destroy();
      panel = null;
      badge?.destroy();
      badge = null;
      mountedTarget = null;
    }

    function sync(): void {
      const itemId = extractItemIdFromUrl(location.href);
      if (itemId !== null) {
        const want = `items:${itemId}`;
        if (want === mountedTarget) {
          // バッジ/パネルが BOOTH 側の再描画で消された場合は付け直す
          if (
            !document.getElementById("boothreview-panel-host") ||
            (findMountAnchor(document) !== null &&
              document.getElementById("boothreview-badge-host") === null)
          ) {
            panel?.destroy();
            panel = null;
            badge?.destroy();
            badge = null;
            mountItem(itemId);
          }
          return;
        }
        unmount();
        mountItem(itemId);
        return;
      }

      // ショップページ (サブドメインあり & /items/ 無し)
      if (isShopPage(location.href)) {
        const shop = extractShopFromUrl(location.href) as string;
        const want = `shop:${shop}`;
        if (want === mountedTarget) {
          // バッジ/パネルが BOOTH 側の再描画で消された場合は付け直す
          if (
            !document.getElementById("boothreview-panel-host") ||
            !document.getElementById("boothreview-badge-host")
          ) {
            panel?.destroy();
            panel = null;
            badge?.destroy();
            badge = null;
            mountShop(shop);
          }
          return;
        }
        unmount();
        mountShop(shop);
        return;
      }

      if (mountedTarget !== null) unmount();
    }

    sync();

    // URL 変化・DOM 変化の監視
    const observer = new MutationObserver(() => sync());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", sync);
    window.setInterval(sync, 1000);
  },
});
