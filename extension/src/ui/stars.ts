/**
 * 評価値 (0〜5) を 5 個の星で表示する共通 UI 部品。
 *
 * - 塗りつぶし部分: ★ をオレンジ (#FF6201) で、評価値に応じた幅だけ上に重ねる
 *   (例: 平均 4.4 → 4個分 + 5個目の 40% がオレンジ)
 * - 塗りつぶし前の星はグレーの ★
 * - rating === null (レビュー 0 件) は全てグレー
 * - インラインスタイルのみで構成 (一覧チップの通常 DOM と、
 *   商品ページバッジの Shadow DOM の両方で其のまま使える)
 */

const STAR_GLYPHS = "★★★★★";
const STAR_EMPTY_COLOR = "#b3ada2";
const STAR_FILL_COLOR = "#FF6201";

export function buildStars(rating: number | null, fontSize: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.style.position = "relative";
  wrap.style.display = "inline-block";
  wrap.style.fontSize = `${fontSize}px`;
  wrap.style.lineHeight = "1.2";
  wrap.style.verticalAlign = "middle";

  // 寸法の素になる下地 (全員グレー) 。ここから上にオレンジを幅クリップで重ねる
  const base = document.createElement("span");
  base.style.display = "inline-block";
  base.style.whiteSpace = "nowrap";
  base.style.color = STAR_EMPTY_COLOR;
  base.textContent = STAR_GLYPHS;

  const fill = document.createElement("span");
  fill.style.display = "inline-block";
  fill.style.position = "absolute";
  fill.style.left = "0";
  fill.style.top = "0";
  fill.style.overflow = "hidden";
  fill.style.whiteSpace = "nowrap";
  fill.style.color = STAR_FILL_COLOR;
  fill.textContent = STAR_GLYPHS;

  const value = rating == null || Number.isNaN(rating) ? 0 : Math.max(0, Math.min(5, rating));
  fill.style.width = `${Math.round((value / 5) * 1000) / 10}%`;

  wrap.append(base, fill);
  wrap.setAttribute("aria-label", rating == null ? "評価なし" : `評価 ${rating} / 5`);
  return wrap;
}
