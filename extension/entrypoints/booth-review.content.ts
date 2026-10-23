import {
  extractItemIdFromUrl,
  extractShopFromUrl,
  findMountAnchor,
  findShopBadgeAnchor,
  findItemBadgeAnchor,
  findBottomMountAnchor,
  attachPanelHost,
  attachBadgeHost,
  attachBadgeHostAfter,
  isShopPage,
} from "../src/core/booth-dom";
import { getOrCreateAnonId } from "../src/core/anon-id";
import { mountPanel, mountBadge, type PanelHandle } from "../src/ui/panel";
import { scanListingChips, listingStats } from "../src/ui/listing";
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
      // ☆チップ: 商品ページはショップ名の横 (カートボタンの付近) に配置。
      // 見つからない場合は従来どおりページ最上部 (main 等) の前へ
      const itemBadgeAnchor = findItemBadgeAnchor(document);
      let badgeHost: HTMLElement | null = null;
      if (itemBadgeAnchor) {
        badgeHost = attachBadgeHostAfter(document, itemBadgeAnchor);
      } else {
        const fallbackAnchor = findMountAnchor(document);
        if (fallbackAnchor) badgeHost = attachBadgeHost(document, fallbackAnchor);
      }
      if (badgeHost) {
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
      // 全ページ共通: 一覧カード (.item-card) に評価チップを挿入
      // (ホーム/検索 だけでなく、ショップの新着一覧や商品ページ下部の関連カードにも出る)
      scanListingChips(document);
      updateDebugBanner();

      const itemId = extractItemIdFromUrl(location.href);
      if (itemId !== null) {
        const want = `items:${itemId}`;
        if (want === mountedTarget) {
          // バッジ/パネルが BOOTH 側の再描画で消された場合は付け直す (連発防止の冷却あり)。
          // ショップカードが遅れてハイドレートされた場合もショップ名の横へ付け直す
          if (
            !document.getElementById("boothreview-panel-host") ||
            (findMountAnchor(document) !== null &&
              !document.getElementById("boothreview-badge-host")) ||
            itemBadgeShouldRelocate()
          ) {
            if (remountAllowed()) {
              panel?.destroy();
              panel = null;
              badge?.destroy();
              badge = null;
              mountItem(itemId);
            }
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
          // バッジ/パネルが BOOTH 側の再描画で消された場合は付け直す (連発防止の冷却あり)
          if (
            !document.getElementById("boothreview-panel-host") ||
            !document.getElementById("boothreview-badge-host")
          ) {
            if (remountAllowed()) {
              panel?.destroy();
              panel = null;
              badge?.destroy();
              badge = null;
              mountShop(shop);
            }
          }
          return;
        }
        unmount();
        mountShop(shop);
        return;
      }

      if (mountedTarget !== null) unmount();

      updateDebugBanner();
    }

    /** 再マウント・ループの自励発振を防ぐ: BOOTH 読込中に毎秒 destroy/rebuild しない */
    const REMOUNT_COOLDOWN_MS = 3000;
    let lastRemountAt = 0;
    function remountAllowed(): boolean {
      const now = Date.now();
      if (now - lastRemountAt < REMOUNT_COOLDOWN_MS) return false;
      lastRemountAt = now;
      return true;
    }

    /**
     * 商品ページの☆チップがショップ名の横に来ていないか。
     * BOOTH はショップカードを遅れて描画するため、初回マウント時に無ければ
     * 最上部にフォールバックして、ここで毎 tick 再配置を試みる。
     */
    function itemBadgeShouldRelocate(): boolean {
      const anchor = findItemBadgeAnchor(document);
      if (!anchor || !anchor.parentElement) return false;
      const host = document.getElementById("boothreview-badge-host");
      if (!host) return false;
      return host.parentElement !== anchor.parentElement || host.previousElementSibling !== anchor;
    }

    /**
     * デバッグバナー (#brdebug を URL 末尾に付けると表示)。
     * 一覧チップの問題を切り分けるための簡易測定 (一般ユーザーへの影響は無し)。
     */
    function updateDebugBanner(): void {
      if (!location.hash.startsWith("#brdebug")) return;
      let banner = document.getElementById("boothreview-debug-banner") as HTMLDivElement | null;
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "boothreview-debug-banner";
        banner.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#173a5e;color:#fff;" +
          "padding:6px 10px;border-radius:6px;font:12px ui-monospace,monospace;pointer-events:none;" +
          "max-width:340px;white-space:normal;";
        document.body.appendChild(banner);
      }
      const chips = document.querySelectorAll("[data-br-rating-chip]").length;
      // 見えている商品アンカーの「最寄りカードコンテナ」のクラス内訳 (どのマークアップに対応不足かを可視化)
      const hist = new Map<string, number>();
      let totalAnchors = 0;
      for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/items/"]')) {
        totalAnchors++;
        const card = a.closest<HTMLElement>('.item-card, .item-card-wrapper, [class*="item-card"], [class*="card"]');
        const key = card ? (Array.from(card.classList)[0] ?? "?") : "(card要素なし)";
        hist.set(key, (hist.get(key) ?? 0) + 1);
      }
      const histText = Array.from(hist.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      banner.textContent =
        `BRチップ ${chips} / 検出カード ${listingStats.cardsFound} / 末尾 ${listingStats.fallbackCards} / ` +
        `id ${listingStats.idsFound} / API ${listingStats.apiOk ? "OK" : "NG"}:${listingStats.apiStatus}\n` +
        `anchor ${totalAnchors} 区分→ ${histText}\n` +
        (listingStats.skipSignatures.length > 0
          ? `シグネチャ→ ${listingStats.skipSignatures.join("  ||  ")}`
          : "シグネチャ→ (なし: 全カード検出)");
      banner.style.whiteSpace = "pre-wrap";
    }

    sync();

    // URL 変化・DOM 変化の監視。MutationObserver が高頻度で発火するので sync はレート制限する
    const MIN_SYNC_INTERVAL_MS = 300;
    let lastSyncAt = 0;
    let syncTimer: number | null = null;
    function scheduleSync(): void {
      if (syncTimer !== null) return;
      const wait = Math.max(0, MIN_SYNC_INTERVAL_MS - (Date.now() - lastSyncAt));
      syncTimer = window.setTimeout(() => {
        syncTimer = null;
        lastSyncAt = Date.now();
        sync();
      }, wait);
    }
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleSync);
    window.setInterval(sync, 1000);
  },
});
