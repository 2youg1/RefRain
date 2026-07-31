/** Central z-order authority: manuscript, lamp, quarters, spine, menu, overlay, modal. */

/** 一层的名字。数字不出现在这个文件之外。 */
export type Stratum = "manuscript" | "lamp" | "quarter" | "spine" | "menu" | "overlay" | "modal";

/**
 * 层的次序。相邻两层留出十的间隔，供一层内部排序（如书脊之间的先后）使用,
 * 而跨层的先后永远由这里决定。
 */
const ORDER: Record<Stratum, number> = {
  manuscript: 10,
  lamp: 20,
  quarter: 30,
  spine: 40,
  // Menus, overlays, and modals sit above the workbench structure.
  menu: 60,
  overlay: 80,
  modal: 100,
};

export function stratum(name: Stratum): number {
  return ORDER[name];
}

/** 自下而上的全部层，供门禁与样式生成遍历。 */
export const STRATA: readonly Stratum[] = Object.keys(ORDER).sort(
  (a, b) => ORDER[a as Stratum] - ORDER[b as Stratum],
) as Stratum[];

/** `a` 是否在 `b` 之上。让「书脊盖不盖得住菜单」成为一个可回答的问题。 */
export function above(a: Stratum, b: Stratum): boolean {
  return ORDER[a] > ORDER[b];
}

/** 层的 CSS 自定义属性名，样式表只引用它，不写数字。 */
export function stratumVar(name: Stratum): string {
  return `--z-${name}`;
}

/** 生成 :root 上的一组层变量，是样式表里 z-index 的唯一来源。 */
export function strataDeclarations(): string {
  return STRATA.map((name) => `  ${stratumVar(name)}: ${ORDER[name]};`).join("\n");
}
