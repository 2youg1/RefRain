/**
 * 工作台的层。
 *
 * KL9 2026-07-30 裁定的层级，自下而上：
 *
 *   正文区 —— 作者写的字。最下面，也是全部东西存在的理由。
 *   光源区 —— 灯。它照亮正文，被上面的东西挡住。
 *   四区   —— 设置、编辑、文件、Agent。立在光里。
 *   书脊   —— 多层。退到后面的面板留下的脊，最上面。
 *
 * 为什么要有这个文件：在此之前层级是**涌现**出来的。十五个 z-index 散在
 * surfaces.css 各处（0/1/5/9/10/20/30/39/40/70/80/90/91/100），每个数字单看都对，
 * 合起来没有一处说明谁该在谁上面。要回答「书脊会不会盖住右键菜单」只能把十五处
 * 全找出来排一遍——而那正是这个文件现在替所有人做完的事。
 *
 * 光的问题也出在这里。原先光是画在纸元素上的一圈 box-shadow，纸和面板是兄弟，
 * 于是「光被面板挡住」根本无从表达，只能靠调阴影参数假装。两盏灯因此怎么调都
 * 差别不大——它们画的是同一个东西上的同一圈影子。光必须是**一层**，在正文之上、
 * 四区之下，被上面的东西真的挡住。
 */

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
  // 以上四层是 KL9 规定的工作台结构。以下三层是压在结构之上的临时物：
  // 菜单在书脊之上（否则右键菜单会被脊盖住），遮罩在菜单之上，模态最高。
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
