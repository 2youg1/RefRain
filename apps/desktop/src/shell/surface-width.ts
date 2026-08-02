/**
 * 侧栏与面板占多宽，由作者说了算。
 *
 * 三档是三个有名有姓的答案：「窄一点」「宽一点」「铺满，我要找资料」。
 * 三档之间还有一个无级的拖动——它不住在这里：拖动的状态、生命周期与
 * DOM 落地归 shell/panel-width.ts，这里只回答「这一档是多少像素」。
 *
 * 「铺满」是其中一档而不是另一个模式：找资料与给 Agent 写指令时，面板就是
 * 此刻的工作区，没有理由让它挤在四百像素里陪着一篇看不见的稿子。
 */

/** 面板的三档宽度。`full` 由 CSS 换算成整个舞台。 */
export type PanelWidth = "narrow" | "regular" | "full";

/** 侧栏的三档宽度。它比面板窄，因为它只放文件名。 */
export type RailWidth = "narrow" | "regular" | "wide";

const PANEL_PX: Readonly<Record<PanelWidth, number>> = {
  narrow: 320,
  regular: 400,
  // 铺满时具体像素由舞台决定，这个数只是它退化前的下限。
  full: 400,
};

const RAIL_PX: Readonly<Record<RailWidth, number>> = {
  // 220：一个中文章节名加两级缩进仍读得完。
  narrow: 220,
  regular: 248,
  wide: 300,
};

export function panelWidthPx(width: PanelWidth): number {
  return PANEL_PX[width];
}

export function railWidthPx(width: RailWidth): number {
  return RAIL_PX[width];
}
