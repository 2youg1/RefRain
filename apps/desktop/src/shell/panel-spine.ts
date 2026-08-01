/**
 * 面板占多宽、正文让多宽。
 *
 * 书脊几何（一层压成一条竖脊）已经退役：它从未被渲染，留着只会让「正文该让
 * 多宽」这个问题有两个互相矛盾的答案。现在整条路径就是一层展开的面板。
 */

/** 展开的那一层有多宽。与 CSS 的 `.panel-layer { width }` 是同一个数。 */
export const PANEL_WIDTH = 400;

/**
 * 整条路径占掉的宽度：几层就是几份面板宽。
 *
 * 正文据此让开。它必须让——面板压在版心上会把每行的行首切掉三五个字，
 * 而中日文与西文都从行首读起，作者拿到的是残句。
 */
export function panelReserve(depth: number): number {
  return Math.max(0, Math.floor(depth)) * PANEL_WIDTH;
}

/**
 * 这条路径此刻在屏幕上的样子。
 *
 * 深度决定两件事：正文让开多宽、舞台算不算「开着面板」。它们必须同时给出——
 * 让开了而没标记开着，或标记了而没让开，作者看到的都是错位。所以是一个投影，
 * 不是两处各算一次。
 */
export interface PanelLayout {
  readonly "data-panels": "open" | "closed";
  readonly style: Record<string, string | undefined>;
}

/**
 * @param hidden 舞台此刻整个让位给别人（设置独占 Stage、或作者在逐句裁决里）。
 */
export function panelLayout(depth: number, hidden: boolean): PanelLayout {
  const reserve = panelReserve(depth);
  return {
    "data-panels": reserve > 0 ? "open" : "closed",
    style: {
      "--panel-reserve": `${reserve}px`,
      // 不显示时不写 display，让样式表自己说了算——写死 undefined 与写死
      // "block" 是两件事，后者会盖掉表里的布局。
      display: hidden ? "none" : undefined,
    },
  };
}
