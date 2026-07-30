export type WorkbenchStage = "writing" | "review" | "dispatch";
export type SettingsSection = "appearance" | "typography" | "shortcuts";
export type WorkbenchReference =
  | { readonly kind: "connections" }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "annotations" };

export interface WorkbenchState<Safety> {
  readonly hasDocument: boolean;
  readonly stage: WorkbenchStage;
  readonly reference: WorkbenchReference | null;
  readonly safety: { readonly kind: "external-conflict"; readonly value: Safety } | null;
}

export type WorkbenchEvent<Safety> =
  | { readonly kind: "documentSelected" }
  | { readonly kind: "openStage"; readonly stage: WorkbenchStage }
  | { readonly kind: "openReference"; readonly reference: WorkbenchReference }
  | { readonly kind: "closeReference" }
  | { readonly kind: "raiseSafety"; readonly value: Safety }
  | { readonly kind: "resolveSafety" };

export const initialWorkbenchState = <Safety>(): WorkbenchState<Safety> => ({
  hasDocument: false,
  stage: "writing",
  reference: null,
  safety: null,
});

const sameReference = (left: WorkbenchReference, right: WorkbenchReference): boolean =>
  left.kind === right.kind &&
  (left.kind !== "settings" || (right.kind === "settings" && left.section === right.section));

/** Own the three independent axes already present in the workbench. */
export function reduceWorkbench<Safety>(
  state: WorkbenchState<Safety>,
  event: WorkbenchEvent<Safety>,
): WorkbenchState<Safety> {
  switch (event.kind) {
    case "documentSelected":
      return {
        hasDocument: true,
        stage: "writing",
        reference: null,
        safety: null,
      };
    case "openStage":
      if (event.stage !== "writing" && !state.hasDocument) return state;
      return { ...state, stage: event.stage, reference: null };
    case "openReference":
      if (event.reference.kind === "annotations" && !state.hasDocument) return state;
      return {
        ...state,
        reference:
          state.reference !== null && sameReference(state.reference, event.reference)
            ? null
            : event.reference,
      };
    case "closeReference":
      return { ...state, reference: null };
    case "raiseSafety":
      return { ...state, safety: { kind: "external-conflict", value: event.value } };
    case "resolveSafety":
      return { ...state, safety: null };
  }
}
