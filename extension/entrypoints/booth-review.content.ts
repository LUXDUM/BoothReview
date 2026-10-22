import { extractItemIdFromUrl, findMountAnchor, attachPanelHost } from "../src/core/booth-dom";
import { getOrCreateAnonId } from "../src/core/anon-id";
import { mountPanel, type PanelHandle } from "../src/ui/panel";

/**
 * BOOTH 商品ページにレビューパネルを差し込む content script。
 *
 * - 対象 URL は patterns で粗く受けて、商品ID抽出 (core/booth-dom.ts) で厳密に判定する
 * - BOOTH は SPA 遷移 (URLだけ変わる/要素だけ再描画される) の可能性があるため
 *   MutationObserver + ポーリングで URL 変化とパネル有無を監視する
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
    let mountedItemId: number | null = null;
    let panel: PanelHandle | null = null;

    function mount(itemId: number): void {
      const anchor = findMountAnchor(document);
      if (!anchor) return; // BOOTH 側 DOM の読み込み待ち (observer が再試行する)
      const host = attachPanelHost(document, anchor);
      // すでに Shadow DOM がある場合 (BOOTH 側再描画でノードだけ消された等) は再利用
      const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      panel = mountPanel({
        shadowRoot,
        itemId,
        getAnonId: () => getOrCreateAnonId(),
      });
      mountedItemId = itemId;
    }

    function unmount(): void {
      panel?.destroy();
      panel = null;
      mountedItemId = null;
    }

    function sync(): void {
      const itemId = extractItemIdFromUrl(location.href);
      if (itemId === null) {
        if (mountedItemId !== null) unmount();
        return;
      }
      if (itemId === mountedItemId) {
        // パネルが BOOTH 側の再描画で消された場合は付け直す
        const host = document.getElementById("boothreview-panel-host");
        if (!host) {
          panel?.destroy();
          panel = null;
          mount(itemId);
        }
        return;
      }
      unmount();
      mount(itemId);
    }

    sync();

    // URL 変化・DOM 変化の監視
    const observer = new MutationObserver(() => sync());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", sync);
    window.setInterval(sync, 1000);
  },
});
