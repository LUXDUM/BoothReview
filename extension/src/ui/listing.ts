import { api } from "./api";

/**
 * 商品一覧ページ (ホーム / 検索 / カテゴリ 等) の item-card に評価チップを差し込む。
 *
 * 実機 DOM (2026-10 確認):
 *   .item-card
 *     .item-card__wrap
 *       .item-card__thumbnail      … a.js-thumbnail-image[href=".../items/{id}"] を含む
 *       .item-card__summary
 *         .item-card__category     … カテゴリリンク (例: 漫画・マンガ)
 *         .l-item-card-badge       … バッジ (例: VRCHAT)
 *         .item-card__title        … ★チップはこの直前に挿入する (ヘッダーとの間)
 *         .item-card__shop-info
 *         (価格)
 *
 * - チップは Shadow DOM にせず inline style の軽量要素で差し込む (1ページ100件以上でも軽い)
 * - 評価値は /v1/items/ratings?ids=… でバッチ取得 (最大50件/リクエスト)
 * - MutationObserver の毎 tick で再実行しても冪等 (data-br-rating-chip で重複防止)
 */

const CHIP_ATTR = "data-br-rating-chip";
/** 描画済み集計の比較用属性 (同値なら DOM を触らない → MutationObserver の自励発振を防ぐ) */
const CHIP_RENDERED_ATTR = "data-br-rendered";
/** キャッシュ溢れで古い ID が再取得される問題を避けるため、上限は広めに取る */
const CACHE_LIMIT = 2000;
const BATCH_SIZE = 50;

type ChipSummary = { count: number; average: number | null };

/** itemId → 集計 (レビュー 0 件のものはリクエスト済みとして negative キャッシュで保持) */
const cache = new Map<number, ChipSummary>();
/** 取得中の itemId (並発リクエスト防止) */
const inflight = new Set<number>();

export type RatingChipHandle = { destroy(): void };

function itemIdFromAnchor(anchor: HTMLAnchorElement): number | null {
  try {
    const m = new URL(anchor.href).pathname.match(/\/items\/(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** (card, title) の組。title が無いカードは挿入位置を判定できないので skip */
function cardTargetOf(anchor: Element): { card: HTMLElement; title: HTMLElement } | null {
  // 旧レイアウト: .item-card / 新レイアウト (Tailwind 化されたホーム等): .item-card-wrapper
  // (実機 2026-10 確認: .item-card-wrapper 内は従来と同じ .item-card__title 等を流用している)
  const card = anchor.closest<HTMLElement>(".item-card") ?? anchor.closest<HTMLElement>(".item-card-wrapper");
  if (!card) return null;
  const title = card.querySelector<HTMLElement>(".item-card__title");
  if (!title) return null;
  return { card, title };
}

function applyChip(card: HTMLElement, title: HTMLElement, summary: ChipSummary | undefined): void {
  const existing = title.previousElementSibling;
  if (existing instanceof HTMLElement && existing.hasAttribute(CHIP_ATTR)) {
    // textContent を毎 tick 再構築すると MutationObserver の無限フィードバックになるので、
    // 内容が変わった時 (ページ入渋時の当初 1 回) だけ更新する (メモリリーク対策)
    const rendered = existing.getAttribute(CHIP_RENDERED_ATTR) ?? "";
    const next = summary ? `${summary.count}|${summary.average ?? ""}` : "none";
    if (rendered === next) return;
    existing.setAttribute(CHIP_RENDERED_ATTR, next);
    updateChipText(existing, summary);
    return;
  }
  // BOOTH 再描画で挿入位置がずれた場合に備え、カード内の古いチップを掃してから挿入
  const stale = card.querySelector<HTMLElement>(`[${CHIP_ATTR}]`);
  if (stale) stale.remove();

  const chip = document.createElement("div");
  chip.className = "booth-review-rating-chip";
  chip.setAttribute(CHIP_ATTR, "");
  chip.setAttribute(CHIP_RENDERED_ATTR, summary ? `${summary.count}|${summary.average ?? ""}` : "none");
  updateChipText(chip, summary);
  title.insertAdjacentElement("beforebegin", chip);
}

function updateChipText(chip: HTMLElement, summary: ChipSummary | undefined): void {
  chip.textContent = "";
  // BOOTH 側 CSS に左右されないよう inline style のバッジ型にする (ShadowRoot 併用は1頁100件で重い)
  chip.style.display = "flex";
  chip.style.alignItems = "center";
  chip.style.gap = "3px";
  chip.style.margin = "3px 0";
  chip.style.padding = "2px 8px";
  chip.style.width = "fit-content";
  chip.style.borderRadius = "10px";
  chip.style.fontSize = "12px";
  chip.style.lineHeight = "1.4";
  chip.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  const star = document.createElement("span");
  star.style.fontSize = "13px";
  const text = document.createElement("span");
  if (!summary || summary.count === 0) {
    // レビュー無し: 控えめだが「UIがある」と分かる薄いピル
    star.textContent = "☆";
    star.style.color = "#b3ada2";
    text.textContent = "レビュー 0件";
    text.style.color = "#a09a90";
    chip.style.background = "#f4f3f0";
    chip.style.border = "1px solid #e6e3dd";
  } else {
    star.textContent = "★";
    star.style.color = "#e8a013";
    text.textContent = `${summary.average?.toFixed(1) ?? "-"} (${summary.count}件)`;
    text.style.color = "#8a5b00";
    text.style.fontWeight = "700";
    chip.style.background = "#fff6de";
    chip.style.border = "1px solid #f0d791";
  }
  chip.append(star, text);
}

async function fetchMissing(ids: number[]): Promise<void> {
  const missing = ids.filter((id) => !cache.has(id) && !inflight.has(id));
  if (missing.length === 0) return;
  for (const id of missing) inflight.add(id);
  try {
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const res = await api.ratings(batch);
      for (const id of batch) {
        inflight.delete(id);
        const found = res.ok ? res.data.ratings[String(id)] : undefined;
        // 取得失敗 (ok:false) でも「存在しない = レビューなし」として記録し、毎 tick の再取得を防ぐ。
        // 後続の成功 tick で上書きされることはないが、ページ再読込で取り直されるので実害は小さい。
        cache.set(id, found ?? { count: 0, average: null });
      }
      if (!res.ok && res.status === 429) return; // レート制限中は残りバッチを撃たない
    }
    // キャッシュ上限 (LRU 風に先頭から落とす)
    while (cache.size > CACHE_LIMIT) {
      const first = cache.keys().next();
      if (first.done) break;
      cache.delete(first.value);
    }
  } finally {
    for (const id of missing) inflight.delete(id);
  }
}

/**
 * 一覧ページのカードを走査してチップを挿入/更新する。
 * sync() の毎 tick から呼ばれてよい (内部でキャッシュ・重複防止するため)。
 */
export function scanListingChips(doc: Document): void {
  const anchors = doc.querySelectorAll<HTMLAnchorElement>('a[href*="/items/"]');
  if (anchors.length === 0) return;

  /** card → (title, itemId)。1 カードに画像/タイトル等の複数アンカーがあっても 1 チップにまとめる */
  const targets = new Map<HTMLElement, { id: number; title: HTMLElement }>();
  for (const anchor of anchors) {
    const id = itemIdFromAnchor(anchor);
    if (id === null) continue;
    const t = cardTargetOf(anchor);
    if (!t) continue;
    if (!targets.has(t.card)) targets.set(t.card, { id, title: t.title });
  }
  if (targets.size === 0) return;

  void (async () => {
    await fetchMissing(Array.from(targets.values(), (t) => t.id));
    for (const [card, t] of targets) {
      applyChip(card, t.title, cache.get(t.id));
    }
  })();
}
