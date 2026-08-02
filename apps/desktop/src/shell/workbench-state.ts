export type WorkbenchStage = "writing" | "review" | "dispatch";
export type SettingsSection = "appearance" | "typography" | "shortcuts";
export type WorkbenchReference =
  | { readonly kind: "connections" }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "annotations" }
  /** 当前文档的正文行动历史，可选择性回档。 */
  | { readonly kind: "history" }
  /** 发送信箱的管理页：三格全量、批量动作与回收站。 */
  | { readonly kind: "mailbox" }
  /** 导入来源的原始页面，与投影出的文本并排。 */
  | { readonly kind: "source" };

/**
 * 工作台的两条轴。
 *
 * 「打开到哪一层面板」不在这里——那是 `PanelStack` 的事。它一度也住在这个 state 里，
 * 于是同一件事有两份记录：栈压了一层，reducer 也存了一个 reference，谁对看调用次序。
 * 现在这里只留下栈无法回答的事：作者在哪个场景（写作/逐句裁决/发送），
 * 以及手上有没有一份打开的稿子。
 */
export interface WorkbenchState {
  readonly hasDocument: boolean;
  readonly stage: WorkbenchStage;
}

export type WorkbenchEvent =
  | { readonly kind: "documentSelected" }
  | { readonly kind: "projectChanged" }
  | { readonly kind: "openStage"; readonly stage: WorkbenchStage };

export const initialWorkbenchState = (): WorkbenchState => ({
  hasDocument: false,
  stage: "writing",
});

/** Own the axes the panel stack cannot answer. */
export function reduceWorkbench(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  switch (event.kind) {
    case "documentSelected":
      return { hasDocument: true, stage: "writing" };
    // 换项目等于换了一份稿子的世界：打开的文档不再属于这里。
    case "projectChanged":
      return { hasDocument: false, stage: "writing" };
    case "openStage":
      if (event.stage !== "writing" && !state.hasDocument) return state;
      return { ...state, stage: event.stage };
  }
}
