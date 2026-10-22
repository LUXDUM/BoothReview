/**
 * WXT (ビルドツール) の設定。
 *
 * WXT を選定した理由 (README にも記載):
 * - Manifest V3 向けのボイラープレート (manifest 生成・HMR・自動リロード) を減らせる
 * - TypeScript 標準対応、Vite ベースで軽量・ビルドが速い
 * - content script / service worker といった MV3 概念を1ファイルずつ entrypoints に書く形
 */

// API のオリジン。README の手順どおり、自分の Cloudflare Tunnel ドメインに書き換えること。
// host_permissions にはビルド時にこの値が焼き込まれる。
import { defineConfig } from "wxt";
import { API_ORIGIN } from "./src/shared/config";

export default defineConfig({
  manifest: {
    name: "BOOTH 商品ページ 第三者レビュー",
    description: "BOOTH 商品ページ上に当サービスのレビューを表示・投稿できる拡張です。BOOTH 本体には送信しません。",
    permissions: ["storage"],
    host_permissions: ["*://*.booth.pm/*", `${API_ORIGIN}/*`],
  },
});
