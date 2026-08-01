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
