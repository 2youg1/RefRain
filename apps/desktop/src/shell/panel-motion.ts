/**
 * 面板怎么进来：从哪一侧，用多久。
 *
 * 两个值都只在这里定一次。散出去的代价很具体——时长写在 CSS 里、方向写在组件里，
 * 关掉动画那天就要改两处，漏一处就是「关了还在动」。
 *
 * **1ms 而非 0。** 关掉动画是把时间压到看不见，不是换一条没有过渡的代码路径；
 * 保留同一条路径，意味着「开着动画能用」与「关掉动画能用」不会分叉成两种行为。
 *
 * 缓动是先快后慢（decelerate）：面板一出现就到位大半，最后一小段慢下来贴住。
 * 反过来的先慢后快会让人觉得界面在拖，而这个动画的全部意义是让熟手不被打断。
 */

import type { PanelSide } from "./panel-stack";

/** 展开一层用多久。KL9 定：约 300ms。 */
export const PANEL_MOTION_MS = 300;
/** 关掉动画后的时长。不是 0——见文件头。 */
export const PANEL_STILL_MS = 1;
/** 先快后慢。最后一段贴住，而不是匀速滑到位。 */
export const PANEL_EASING = "cubic-bezier(0.16, 0.84, 0.34, 1)";

export interface PanelMotion {
  /** 毫秒。渲染层把它写进 CSS 变量，不自己判断。 */
  readonly duration: number;
  readonly easing: string;
  readonly side: PanelSide;
  /** 面板从这个方向滑入：left 侧的栈从左边进来。 */
  readonly enterFrom: "-100%" | "100%";
}

/**
 * 把作者的选择与系统的意愿合成一个答案。
 *
 * 系统层面说了「减少动态效果」时不再问用户设置——那是无障碍偏好，不是审美偏好，
 * 让一个应用内开关覆盖它是不对的。
 */
export function panelMotion(
  side: PanelSide,
  animated: boolean,
  prefersReducedMotion: boolean,
): PanelMotion {
  return {
    duration: animated && !prefersReducedMotion ? PANEL_MOTION_MS : PANEL_STILL_MS,
    easing: PANEL_EASING,
    side,
    enterFrom: side === "left" ? "-100%" : "100%",
  };
}

/** 浏览器此刻是否要求减少动态效果。没有 matchMedia 的环境按「不要求」算。 */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
