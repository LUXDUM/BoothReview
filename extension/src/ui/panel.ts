import type { ApiReview } from "../shared/types";
import { api, type MutationResult } from "./api";
import { buildStars } from "./stars";

/**
 * BOOTH ページに差し込むレビューパネル。
 * - Shadow DOM で BOOTH 側 CSS との干渉を隔離する
 * - レビュー本文は textContent で表示し、HTML として解釈しない (XSS対策)
 */

export type PanelHandle = { destroy(): void };

type CreateEl<T extends HTMLElement = HTMLElement> = {
  (tag: string, cls?: string, text?: string): T;
};

type MountDeps = {
  shadowRoot: ShadowRoot;
  itemId: number;
  getAnonId(): Promise<string>;
  /** ショップページモード。itemId は無視され、ショップ集計 API を使う */
  mode?: "item" | "shop";
  /** ショップモードでの対象ショップ (BOOTH のサブドメイン) */
  shop?: string | null;
  /** 投稿・編集時に現在URLのショップ紐付けを付けるためのコールバック */
  getShop?: () => string | null;
};

export function mountPanel(deps: MountDeps): PanelHandle {
  const { shadowRoot, itemId, getAnonId, mode = "item", shop = null, getShop } = deps;
  const isShop = mode === "shop" && shop !== null;

  let page = 1;
  let totalPages = 1;
  let mine: ApiReview | null = null;
  /** 自分の匿名ID (ローカル表示のみ。API送信には毎回 getAnonId() を使う) */
  let myAnonId: string | null = null;
  let editing = false;
  let destroyed = false;
  let selectedRating = 0;

  const el: CreateEl = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node as HTMLElement;
  };

  /** type="button" 付きの <button> を作るヘルパー */
  const btn = (cls: string, text: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.type = "button";
    return b;
  };

  // ---- skeleton ----
  shadowRoot.innerHTML = "";
  const styleNode = document.createElement("style");
  styleNode.textContent = PANEL_CSS;
  const root = el("div", "br-root");

  const summaryLine = el("div", "br-summary", "レビューを読み込み中…");
  const list = el("ol", "br-list") as HTMLOListElement;
  const moreWrap = el("div", "br-more");
  const formArea = el("div", "br-form");
  const statusArea = el("div", "br-status");

  if (isShop) {
    // ショップページでは「どの商品へのレビューか」が文脈としてないため投稿フォームは出さない
    root.append(summaryLine, list, moreWrap, statusArea);
  } else {
    root.append(summaryLine, list, moreWrap, formArea, statusArea);
    renderForm();
  }
  shadowRoot.append(styleNode, root);

  function setStatus(message: string, isError = false): void {
    statusArea.replaceChildren(el("div", isError ? "br-status br-error" : "br-status", message));
  }

  function clearStatus(): void {
    statusArea.replaceChildren();
  }

  function stars(rating: number): string {
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // ---- list / summary ----

  /** 通報ボタンを作る共通ヘルパー */
  function createReportButton(review: ApiReview): HTMLButtonElement {
    const reportBtn = btn("br-link", "通報");
    reportBtn.addEventListener("click", async () => {
      if (!confirm("このレビューを通報しますか?")) return;
      clearStatus();
      try {
        const anonId = await getAnonId();
        const res = await api.report(review.id, anonId);
        handleMutation(res, "通報を受け付けました");
      } catch (e) {
        setStatus(asMessage(e), true);
      }
    });
    return reportBtn;
  }

  function renderReviewItem(review: ApiReview): HTMLLIElement {
    const li = el("li", "br-item") as HTMLLIElement;
    const head = el("div", "br-item-head");
    head.append(el("span", "br-stars", stars(review.rating)));
    // 投稿者の匿名ID短縮ハッシュ (サーバー付与。なりすまし防止のため生UUIDは出さない)
    if (review.author) {
      head.append(el("span", "br-anon", `匿名 ${review.author}`));
    }
    head.append(el("time", "br-date", formatDate(review.createdAt)));
    // 本文は textContent のみ (innerHTML は使わない)
    const body = el("div", "br-body", review.body);
    const foot = el("div", "br-item-foot");
    if (isShop && shop && review.itemId !== undefined) {
      // ショップ一覧では元商品へのリンクを付ける
      const link = document.createElement("a");
      link.className = "br-item-link";
      link.href = `https://${shop}.booth.pm/items/${review.itemId}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "商品ページへ ↗";
      foot.append(link, createReportButton(review));
      li.append(head, body, foot);
      return li;
    }
    foot.append(createReportButton(review));
    li.append(head, body, foot);
    return li;
  }

  function handleMutation(res: MutationResult, successMessage: string): void {
    if (!res.ok) {
      setStatus(errorMessage(res), true);
      return;
    }
    setStatus(successMessage);
    void refresh({ resetPage: true, reloadMine: true });
  }

  async function refresh(opts?: { resetPage?: boolean; reloadMine?: boolean }): Promise<void> {
    if (destroyed) return;
    if (opts?.resetPage) page = 1;

    const [mineRes, summaryRes] = await Promise.all([
      isShop ? Promise.resolve(null) : (opts?.reloadMine === false ? Promise.resolve(null) : loadMine()),
      isShop ? api.shopSummary(shop as string) : api.summary(itemId),
    ]);
    if (mineRes) mine = mineRes.ok ? mineRes.data.review : null;
    if (!isShop) renderForm();

    if (!summaryRes.ok) {
      summaryLine.textContent = errorMessage(summaryRes);
      return;
    }
    const { count, average } = summaryRes.data;
    summaryLine.textContent =
      count === 0
        ? "まだレビューがありません。商品ページから最初のレビューを書いてみませんか?"
        : `★ ${average ?? "-"} (${count}件のレビュー)`;

    const listRes = isShop
      ? await api.shopList(shop as string, page)
      : await api.list(itemId, page);
    if (!listRes.ok) {
      setStatus(errorMessage(listRes), true);
      return;
    }
    totalPages = Math.max(1, listRes.data.totalPages);
    list.replaceChildren(...listRes.data.reviews.map(renderReviewItem));

    moreWrap.replaceChildren();
    if (page < totalPages) {
      const more = btn("br-button br-more-btn", "もっと見る");
      more.addEventListener("click", () => {
        page += 1;
        void refresh({ reloadMine: false });
      });
      moreWrap.append(more);
    }
  }

  async function loadMine(): Promise<ReturnType<typeof api.mine> | null> {
    try {
      const anonId = await getAnonId();
      myAnonId = anonId; // フォームの「あなたの匿名ID」表示用
      return await api.mine(itemId, anonId);
    } catch (e) {
      // 匿名IDが取得できない環境では「自分のレビュー」を表示できないだけ
      void e;
      return null;
    }
  }

  function errorMessage(res: { message: string; code?: string; status: number }): string {
    if (res.status === 429) {
      return "リクエストが集中しています。しばらく待ってから再試行してください。";
    }
    if (res.status === 0) {
      return `APIに接続できません (${res.message})`;
    }
    return res.message;
  }

  function asMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // ---- post / edit form (selection state は冒頭で宣言済み) ----

  function renderForm(): void {
    formArea.replaceChildren();

    const titleText =
      editing ? "レビューを編集" : mine ? "あなたのレビューを更新" : "レビューを投稿";
    const title = el("div", "br-form-title", titleText);

    if (mine && !editing) {
      // 自分のレビューが公開/非確認を含めて存在する場合の案内
      title.append(el("span", "br-form-note", "編集 / 削除 は下のフォームから行えます"));
    }

    // 自分の匿名IDを見える化。短縮ハッシュはサーバー側 (pepper 付き HMAC) で生成されるため
    // クライアントでは再計算できない — 一覧の「匿名 ■■■■■■■■」がこの ID から作られていることを案内する
    if (myAnonId) {
      title.append(
        el("span", "br-form-note", `あなたの匿名ID: ${myAnonId} — 一覧の「匿名 ●●●●●●●●」はこのIDから生成された短縮ハッシュです`),
      );
    }

    // 星の選択
    const starsRow = el("div", "br-star-input");
    for (let r = 1; r <= 5; r++) {
      const starBtn = btn("br-star", "★");
      starBtn.setAttribute("aria-label", `${r}つ星で評価`);
      starBtn.addEventListener("click", () => {
        selectedRating = r;
        paintStars();
      });
      starsRow.append(starBtn);
    }
    function paintStars(): void {
      const buttons = starsRow.querySelectorAll<HTMLButtonElement>(".br-star");
      buttons.forEach((b, i) => {
        b.classList.toggle("br-star-on", i < selectedRating);
      });
      ratingLabel.textContent = selectedRating === 0 ? "評価を選択" : `${selectedRating}/5`;
    }
    const ratingLabel = el("span", "br-rating-label", selectedRating === 0 ? "評価を選択" : `${selectedRating}/5`);

    const textarea = el("textarea", "br-textarea") as HTMLTextAreaElement;
    textarea.value = editing && mine ? mine.body : "";
    textarea.rows = 4;
    textarea.maxLength = 2000;
    textarea.placeholder = "レビュー本文 (10〜2000文字)";

    const counter = el("div", "br-counter", `${textarea.value.length} 文字`);
    textarea.addEventListener("input", () => {
      counter.textContent = `${textarea.value.length} 文字`;
    });

    const submit = btn("br-button br-submit", mine && !editing ? "更新する" : "投稿する");
    submit.disabled = true;
    function submitEnabled(rating: number, bodyValue: string): void {
      submit.disabled = !(rating >= 1 && bodyValue.trim().length >= 10);
    }

    textarea.addEventListener("input", () => submitEnabled(selectedRating, textarea.value));
    starsRow.addEventListener("click", () => submitEnabled(selectedRating, textarea.value));

    const cancelBtn = btn("br-link", "キャンセル");
    cancelBtn.addEventListener("click", () => {
      editing = false;
      selectedRating = 0;
      renderForm();
    });

    // 禁止事項の注意書き (仕様 5.4)
    const notice = el(
      "div",
      "br-notice",
      "投稿の禁止事項: 有料アセットの中身の転載、誹謗中傷・スパムなどの投稿はできません。違反や報告が多いレビューは自動的に非表示になります。",
    );
    const disclaimer = el(
      "div",
      "br-disclaimer",
      "このレビューは当拡張のサーバーにのみ保存されます (BOOTH へは送信しません)。投稿内容は匿名IDと紐づいて管理されます。",
    );

    const actions = el("div", "br-actions");
    actions.append(submit);
    if (mine) actions.append(cancelBtn);

    submit.addEventListener("click", async () => {
      const body = textarea.value;
      if (selectedRating < 1 || body.trim().length < 10) return;
      submit.disabled = true;
      clearStatus();
      try {
        const anonId = await getAnonId();
        if (editing && mine) {
          const res = await api.patch(mine.id, { rating: selectedRating, body }, anonId, getShop?.() ?? null);
          editing = false;
          handleMutation(res, "レビューを更新しました");
        } else {
          const res = await api.post(itemId, selectedRating, body, anonId, getShop?.() ?? null);
          handleMutation(res, mine ? "レビューを更新しました" : "レビューを投稿しました");
        }
      } catch (e) {
        submit.disabled = false;
        setStatus(asMessage(e), true);
      }
    });

    // 自分のレビューに対する編集・削除ボタン (フォーム上部)
    if (mine) {
      const mineBar = el("div", "br-mine-bar");
      mineBar.append(el("span", "br-mine-label", `あなたのレビュー: ${stars(mine.rating)}`));
      const editBtn = btn("br-link", "編集");
      editBtn.addEventListener("click", () => {
        editing = true;
        selectedRating = mine!.rating;
        renderForm();
      });
      const deleteBtn = btn("br-link", "削除");
      deleteBtn.addEventListener("click", async () => {
        if (!confirm("レビューを削除しますか?")) return;
        clearStatus();
        try {
          const anonId = await getAnonId();
          const res = await api.remove(mine!.id, anonId);
          editing = false;
          selectedRating = 0;
          handleMutation(res, "レビューを削除しました");
        } catch (e) {
          setStatus(asMessage(e), true);
        }
      });
      mineBar.append(editBtn, deleteBtn);
      formArea.append(mineBar);
    }

    formArea.append(
      title,
      starsRow,
      ratingLabel,
      textarea,
      counter,
      actions,
      notice,
      disclaimer,
    );
    paintStars();
  }

  void refresh({ resetPage: true, reloadMine: true });

  return {
    destroy(): void {
      destroyed = true;
      if (shadowRoot.host.isConnected && shadowRoot.host.id === "boothreview-panel-host") {
        shadowRoot.host.remove();
      }
    },
  };
}

const PANEL_CSS = `
  .br-root {
    all: initial;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #222;
    background: #fafafa;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 12px;
    margin: 8px 0;
    display: block;
  }
  .br-summary { font-weight: 600; margin-bottom: 8px; }
  .br-list { list-style: none; margin: 0; padding: 0; }
  .br-item { border-top: 1px solid #eee; padding: 8px 0; }
  .br-item:first-child { border-top: none; }
  .br-item-head { display: flex; gap: 12px; align-items: baseline; }
  .br-stars { color: #e8a013; letter-spacing: 2px; font-weight: 600; white-space: nowrap; }
  .br-date { color: #777; font-size: 12px; }
  .br-anon { color: #999; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .br-body { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
  .br-item-foot { display: flex; justify-content: flex-end; }
  .br-form { margin-top: 10px; border-top: 1px solid #eee; padding-top: 10px; }
  .br-form-title { font-weight: 600; margin-bottom: 6px; }
  .br-form-note { color: #888; font-size: 12px; margin-left: 8px; font-weight: 400; }
  .br-star-input { display: inline-flex; gap: 2px; }
  .br-star { font-size: 20px; cursor: pointer; color: #bbb; background: none; border: none; padding: 0 2px; line-height: 1; }
  .br-star-on { color: #e8a013; }
  .br-rating-label { margin-left: 8px; font-size: 12px; color: #555; }
  .br-textarea { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; font: inherit; resize: vertical; }
  .br-counter { color: #888; font-size: 12px; text-align: right; }
  .br-button { background: #0074c8; color: #fff; border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .br-button:disabled { opacity: .45; cursor: default; }
  .br-more { text-align: center; margin: 6px 0; }
  .br-more .br-more-btn { background: #eee; color: #333; }
  .br-actions { display: flex; gap: 12px; align-items: center; margin-top: 6px; }
  .br-notice, .br-disclaimer { color: #777; font-size: 12px; margin-top: 8px; }
  .br-disclaimer { margin-top: 4px; }
  .br-mine-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; background: #f0f6fb; border-radius: 6px; padding: 6px 8px; }
  .br-mine-label { font-size: 13px; }
  .br-status { min-height: 18px; margin-top: 4px; }
  .br-status.br-error { color: #b3261e; }
  .br-link { background: none; border: none; color: #0074c8; cursor: pointer; padding: 2px 4px; font: inherit; font-size: 13px; }
  .br-item-link { color: #0074c8; font-size: 12px; text-decoration: none; }
  .br-item-link:hover { text-decoration: underline; }
`;

export type BadgeHandle = { destroy(): void };

type BadgeTarget = { kind: "item"; itemId: number } | { kind: "shop"; shop: string };

/**
 * 「全体評価 ★チップ」 (商品: ショップ名の横 / ショップ: ページ最上部)。
 * 押すとページ下部のレビュー一覧までスクロールする。
 */
export function mountBadge(deps: { shadowRoot: ShadowRoot; target: BadgeTarget }): BadgeHandle {
  const { shadowRoot, target } = deps;

  shadowRoot.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = BADGE_CSS;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "brb-root";
  badge.setAttribute("aria-label", "全レビュー評価へ移動");
  const starRow = buildStars(null, 14);
  const label = document.createElement("span");
  label.className = "brb-label";
  label.textContent = "読み込み中…";
  badge.append(starRow, label);
  shadowRoot.append(style, badge);

  void (async () => {
    const res =
      target.kind === "item" ? await api.summary(target.itemId) : await api.shopSummary(target.shop);
    if (!res.ok) {
      badge.replaceChildren(buildStars(null, 14), label);
      label.className = "brb-label";
      label.textContent = "レビュー";
      return;
    }
    const { count, average } = res.data;
    if (count === 0) {
      badge.replaceChildren(buildStars(null, 14), label);
      label.className = "brb-label brb-none";
      label.textContent = "(0)";
      return;
    }
    // 5個の星を評価値ぶん塗りつぶし。平均は黒字・件数は (n) (簡素なUI)
    badge.replaceChildren(buildStars(average, 14), label);
    label.className = "brb-label";
    label.textContent = `${average?.toFixed(1) ?? "-"} (${count})`;
  })();

  badge.addEventListener("click", () => {
    const panel = document.getElementById("boothreview-panel-host");
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  return {
    destroy(): void {
      const host = shadowRoot.host;
      if (host.isConnected && host.id === "boothreview-badge-host") {
        host.remove();
      }
    },
  };
}

const BADGE_CSS = `
  .brb-root {
    all: initial;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: #111;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    text-align: left;
  }
  .brb-label.brb-none { color: #999; }
`;
