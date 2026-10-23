import { api } from "./api";
import { buildStars } from "./stars";

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

/** #brdebug 用の診断値 (content script から参照してバナー表示する) */
export const listingStats = {
  /** 最終走査で検出したカード数 (title も見つかったもの) */
  cardsFound: 0,
  /** 最終走査で item がリンク付きとして認識された数 (ページ内ユニーク id) */
  idsFound: 0,
  /** タイトルが見つからずカード末尾挿入にフォールバックしたカード数 */
  fallbackCards: 0,
  /** チップを付けられなかった要素の構造シグネチャ (親チェーン, 重複排除・最大4件) */
  skipSignatures: [] as string[],
  /** 最後の ratings API の状態 */
  apiStatus: 0 as number,
  apiOk: false as boolean,
};

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
  // 旧レイアウト: .item-card / 新レイアウト (ホーム等): .item-card-wrapper
  // (実機 2026-11 確認: wrapper 型は .item-card__title の div が無く、タイトルが a.item-card__title-anchor そのもの)
  const card = anchor.closest<HTMLElement>(".item-card") ?? anchor.closest<HTMLElement>(".item-card-wrapper");
  if (!card) return null;
  const title =
    card.querySelector<HTMLElement>(".item-card__title") ??
    card.querySelector<HTMLElement>("[class*='item-card__title-anchor']");
  if (!title) return null;
  return { card, title };
}

/** タイトル構造が不明な wrapper 型の位置特定: カテゴリタグ/バッジ行の下にあるタイトル<a>を返す */
function fallbackTitleOf(card: HTMLElement): HTMLElement | null {
  // 実機 2026-11: タイトルは <a href=itemURL><div class="mt-[6px] typography-14 line-clamp-2 …"><span>…
  // カテゴリ (typography-12) と区別するため line-clamp / typography-14 を優先する
  const inner =
    card.querySelector<HTMLElement>("a[href] > div.line-clamp-2") ??
    card.querySelector<HTMLElement>("a[href] > div[class*='line-clamp']") ??
    card.querySelector<HTMLElement>("a[href] > div[class*='typography-14']");
  if (!inner) return null;
  const a = inner.parentElement;
  // <a> 自体がカード直下 (画像オーバーレイ等) の場合はタイトル行ではない
  if (!a || a === card || !(a instanceof HTMLAnchorElement)) return null;
  return a;
}

/** デバッグバナー用: アンカー周辺の構造シグネチャ (親4段, tag.クラス先頭2個) */
function anchorSignature(anchor: Element): string {
  const parts: string[] = [];
  let el: Element | null = anchor;
  for (let i = 0; i < 4 && el; i++) {
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") ?? "");
    const first = cls
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    parts.unshift(`${el.tagName.toLowerCase()}${first ? `.${first}` : ""}`);
    el = el.parentElement;
  }
  return parts.join(" > ");
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
  // 簡素なUI: 背景枠なし。5個の星を評価値ぶんだけオレンジで塗りつぶし (未塗りはグレー)
  chip.style.display = "inline-flex";
  chip.style.alignItems = "center";
  chip.style.gap = "4px";
  chip.style.margin = "3px 0";
  chip.style.padding = "0";
  chip.style.fontSize = "12px";
  chip.style.lineHeight = "1.4";
  chip.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  const rated = summary !== undefined && summary.count > 0 && summary.average !== null;
  const text = document.createElement("span");
  if (!rated) {
    text.textContent = "(0)";
    text.style.color = "#999";
  } else {
    text.textContent = `${summary.average?.toFixed(1) ?? "-"} (${summary.count})`;
    text.style.color = "#111";
    text.style.fontWeight = "500";
  }
  chip.append(buildStars(rated ? (summary.average as number) : null, 12), text);
}

async function fetchMissing(ids: number[]): Promise<void> {
  const missing = ids.filter((id) => !cache.has(id) && !inflight.has(id));
  if (missing.length === 0) return;
  for (const id of missing) inflight.add(id);
  try {
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const res = await api.ratings(batch);
      listingStats.apiStatus = res.status;
      listingStats.apiOk = res.ok;
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
  if (anchors.length === 0) {
    listingStats.idsFound = 0;
    listingStats.cardsFound = 0;
    listingStats.fallbackCards = 0;
    listingStats.skipSignatures.length = 0;
    return;
  }

  /** card → (title, itemId)。1 カードに画像/タイトル等の複数アンカーがあっても 1 チップにまとめる */
  const targets = new Map<HTMLElement, { id: number; title: HTMLElement }>();
  /** タイトル要素が見つからないカード → カード末尾にチップを足すフォールバック */
  const fallbackTargets = new Map<HTMLElement, { id: number }>();
  /** 位置特定できなかったカード (バナー用シグネチャの収集元) */
  const unknownCards: HTMLElement[] = [];
  const ids = new Set<number>();
  const signatures = new Set<string>();
  for (const anchor of anchors) {
    const id = itemIdFromAnchor(anchor);
    if (id === null) continue;
    ids.add(id);
    const t = cardTargetOf(anchor);
    if (t) {
      if (!targets.has(t.card)) targets.set(t.card, { id, title: t.title });
      continue;
    }
    // タイトル無し → wrapper 内でタイトル<a> (line-clamp 等) を位置特定できれば通常パスで挿入。
    // それも無ければ末尾に足すフォールバック (タグ下にできない最終手段)
    const card = anchor.closest<HTMLElement>(".item-card-wrapper");
    if (card && !targets.has(card)) {
      const pos = fallbackTitleOf(card);
      if (pos) {
        targets.set(card, { id, title: pos });
      } else if (!fallbackTargets.has(card)) {
        fallbackTargets.set(card, { id });
        unknownCards.push(card);
      }
    } else if (!card) {
      signatures.add(anchorSignature(anchor));
    }
  }
  listingStats.idsFound = ids.size;
  listingStats.cardsFound = targets.size;
  listingStats.fallbackCards = fallbackTargets.size;
  listingStats.skipSignatures = unknownCards.length
    ? unknownCards.slice(0, 2).map((card) => `${card.children.length}子: ${Array.from(card.children).map((c) => { const cls = typeof c.className === "string" ? c.className : ""; return c.tagName.toLowerCase() + "." + cls.trim().split(/\s+/).filter(Boolean).slice(0, 2).join("."); }).join(",")}`)
    : Array.from(signatures).slice(0, 4);
  if (targets.size === 0 && fallbackTargets.size === 0) {
    return;
  }

  void (async () => {
    const allIds = [...targets.values().map((t) => t.id), ...fallbackTargets.values().map((t) => t.id)];
    await fetchMissing(allIds);
    for (const [card, t] of targets) {
      applyChip(card, t.title, cache.get(t.id));
    }
    for (const [card, t] of fallbackTargets) {
      applyChipToEnd(card, t.id, cache.get(t.id));
    }
  })();
}

/** タイトル位置が特定できないカード: カード末尾にチップを追加 (既に同 id のチップがあれば位置更新) */
function applyChipToEnd(card: HTMLElement, itemId: number, summary: ChipSummary | undefined): void {
  const existing = card.querySelector<HTMLElement>(`[${CHIP_ATTR}]`);
  if (existing === null) {
    const chip = document.createElement("div");
    chip.className = "booth-review-rating-chip";
    chip.setAttribute(CHIP_ATTR, "");
    chip.setAttribute(CHIP_RENDERED_ATTR, summary ? `${summary.count}|${summary.average ?? ""}` : "none");
    updateChipText(chip, summary);
    card.appendChild(chip);
    return;
  }
  // 既存チップは末尾 keep。カード再描画で末尾でなくなっていないか確認 (違うというのは既に別位置)
  if (existing.parentElement === card && existing === card.lastElementChild) {
    const rendered = existing.getAttribute(CHIP_RENDERED_ATTR) ?? "";
    const next = summary ? `${summary.count}|${summary.average ?? ""}` : "none";
    if (rendered !== next) {
      existing.setAttribute(CHIP_RENDERED_ATTR, next);
      updateChipText(existing, summary);
    }
    return;
  }
  // 位置がずれた (BOOTH 再描画で要素が増えた) → 掃して付け直し
  existing.remove();
  const chip = document.createElement("div");
  chip.className = "booth-review-rating-chip";
  chip.setAttribute(CHIP_ATTR, "");
  chip.setAttribute(CHIP_RENDERED_ATTR, summary ? `${summary.count}|${summary.average ?? ""}` : "none");
  updateChipText(chip, summary);
  card.appendChild(chip);
}
