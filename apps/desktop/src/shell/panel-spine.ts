/**
 * 书脊：一层面板退到只剩一条脊。
 *
 * 打开第二层时，第一层不消失也不被盖住，而是压成一条竖脊立在旁边——书名竖排，
 * 点一下就回到它。走了多深一眼可见，因为脊就一条条排在那里。
 *
 * 这让 `PanelStack.open()` 那条「点栈里靠内的一层是回到它」的规矩第一次在屏幕上
 * 有了对应物：脊就是那一层，点它就是回去。树形文件图、图书馆书架、面包屑，
 * 在这个结构里是同一个东西。
 *
 * 宽度是常数而非比例：脊要能容下竖排的两三个字，与窗口多宽无关。
 */

/** 一条脊的宽度。容得下竖排标题，又不至于把版心挤走。 */
export const SPINE_WIDTH = 34;

/** 展开时脊依次立起的间隔。整条路径的出现读起来像书一本本排上架。 */
export const SPINE_STAGGER_MS = 40;

export interface SpineLayout {
  /** 这条脊左缘距容器起点多远。 */
  readonly offset: number;
  /** 第几条，用来错开出现的时刻。 */
  readonly index: number;
  /** 这条脊比它前面那条晚多久立起来。 */
  readonly delayMs: number;
}

/**
 * 排布已经退成脊的那些层。
 *
 * 最外一层不在这里——它是展开的那一层，占正经宽度。传进来的是它前面的所有层。
 */
export function spineLayout(count: number): readonly SpineLayout[] {
  return Array.from({ length: Math.max(0, count) }, (_unused, index) => ({
    offset: index * SPINE_WIDTH,
    index,
    delayMs: index * SPINE_STAGGER_MS,
  }));
}

/** 展开的那一层从哪里开始：让过它前面所有的脊。 */
export function panelOffset(spineCount: number): number {
  return Math.max(0, spineCount) * SPINE_WIDTH;
}

/** 展开的那一层有多宽。与 CSS 的 `.panel-layer { width }` 是同一个数。 */
export const PANEL_WIDTH = 400;

/**
 * 整条路径占掉的宽度：几条脊，加上展开的那一层。
 *
 * 正文据此让开。它必须让——面板压在版心上会把每行的行首切掉三五个字，
 * 而中日文与西文都从行首读起，作者拿到的是残句。
 */
export function panelReserve(depth: number): number {
  const layers = Math.max(0, Math.floor(depth));
  return layers === 0 ? 0 : panelOffset(layers - 1) + PANEL_WIDTH;
}

/**
 * 整条路径立起来要多久。
 *
 * 加载时可以拿它当进度：脊一条条出现本身就是进度条，不必再画一个。
 */
export function spineSettleMs(count: number, panelMotionMs: number): number {
  return Math.max(0, count - 1) * SPINE_STAGGER_MS + panelMotionMs;
}

/**
 * 这条路径此刻在屏幕上的样子。
 *
 * 深度决定三件事：正文让开多宽、舞台算不算「开着面板」、以及展开的那一层从
 * 哪里起。它们必须同时给出——让开了而没标记开着，或标记了而没让开，
 * 作者看到的都是错位。所以是一个投影，不是三处各算一次。
 */
export interface PanelLayout {
  readonly "data-panels": "open" | "closed";
  readonly style: Record<string, string | undefined>;
}

/**
 * @param hidden 舞台此刻整个让位给别人（设置独占 Stage、或作者在 Review 里）。
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
