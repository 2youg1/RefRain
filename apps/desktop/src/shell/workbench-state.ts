export type WorkbenchStage = "writing" | "review" | "dispatch";
export type SettingsSection = "appearance" | "typography" | "shortcuts";
export type WorkbenchReference =
  | { readonly kind: "connections" }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "annotations" };

/**
 * 工作台的两条轴。
 *
 * 「打开到哪一层面板」不在这里——那是 `PanelStack` 的事。它一度也住在这个 state 里，
 * 于是同一件事有两份记录：栈压了一层，reducer 也存了一个 reference，谁对看调用次序。
 * 现在这里只留下栈无法回答的两件事：作者在哪个场景（写作/Review/派发），
 * 以及有没有一个必须先处理掉的安全事件。
 */
export interface WorkbenchState<Safety> {
  readonly hasDocument: boolean;
  readonly stage: WorkbenchStage;
  readonly safety: { readonly kind: "external-conflict"; readonly value: Safety } | null;
}

export type WorkbenchEvent<Safety> =
  | { readonly kind: "documentSelected" }
  | { readonly kind: "openStage"; readonly stage: WorkbenchStage }
  | { readonly kind: "raiseSafety"; readonly value: Safety }
  | { readonly kind: "resolveSafety" };

export const initialWorkbenchState = <Safety>(): WorkbenchState<Safety> => ({
  hasDocument: false,
  stage: "writing",
  safety: null,
});

/** Own the two axes the panel stack cannot answer. */
export function reduceWorkbench<Safety>(
  state: WorkbenchState<Safety>,
  event: WorkbenchEvent<Safety>,
): WorkbenchState<Safety> {
  switch (event.kind) {
    case "documentSelected":
      return { hasDocument: true, stage: "writing", safety: null };
    case "openStage":
      if (event.stage !== "writing" && !state.hasDocument) return state;
      return { ...state, stage: event.stage };
    case "raiseSafety":
      return { ...state, safety: { kind: "external-conflict", value: event.value } };
    case "resolveSafety":
      return { ...state, safety: null };
  }
}
