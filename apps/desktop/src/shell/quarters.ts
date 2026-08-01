/**
 * Quarters are ordered by use frequency: settings, files, editing, then Agent.
 * A higher quarter may coexist with lower quarters. Closing a lower quarter closes those above it.
 */

/** 四区，自下而上。数组次序就是层的次序。 */
export const QUARTERS = ["settings", "files", "editing", "agent"] as const;

export type Quarter = (typeof QUARTERS)[number];

/** 键盘按层走：Cmd+1..4 直达。层数少、语义稳，所以这套键位背得下来。 */
export function quarterForKey(key: string): Quarter | null {
  const index = Number(key) - 1;
  return QUARTERS[index] ?? null;
}

/** Review owns the stage. Settings and references remain quarters beside the manuscript. */
export function takesWholeStage(scene: { reference: string | null; stage: string }): boolean {
  return scene.stage === "review";
}

/**
 * 工单台此刻是否立在正文旁边。
 *
 * 它不在面板栈里（是舞台的一个 stage，不是 `panels.open` 推进来的一层），但它占的
 * 正是同一条竖带，所以「正文让开多宽」必须把它算进来——少算这一层，正文就不让位，
 * 面板与版心同列，每个字与自己的影子叠在一起（v0.2.2 的第一张灾难图）。
 *
 * 判断放在这里而不是外壳里：这是「哪一区占着正文旁边那条带子」的问题，与
 * `takesWholeStage` 同类；写在外壳里它会被抄成两份，一份给让位、一份给渲染。
 */
export function dispatchBesideManuscript(scene: {
  reference: string | null;
  stage: string;
}): boolean {
  return scene.stage === "dispatch" && scene.reference !== "annotations";
}
