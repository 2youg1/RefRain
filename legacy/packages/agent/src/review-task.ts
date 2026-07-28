import type { TaskContextScope, TaskEditScope } from "./types.ts";

export type ReviewTaskScopeConflict =
  | { readonly kind: "scope-id"; readonly id: string }
  | { readonly kind: "block-id"; readonly id: string };

/** The first identity that would make a Review Task's scopes ambiguous or overlapping. */
export const reviewTaskScopeConflict = (
  contexts: readonly TaskContextScope[],
  edits: readonly TaskEditScope[],
): ReviewTaskScopeConflict | undefined => {
  const scopeIds = new Set<string>();
  for (const scope of contexts) {
    if (scopeIds.has(scope.id)) return { kind: "scope-id", id: scope.id };
    scopeIds.add(scope.id);
  }

  const blockIds = new Set<string>();
  for (const scope of edits) {
    if (scopeIds.has(scope.id)) return { kind: "scope-id", id: scope.id };
    scopeIds.add(scope.id);
    for (const blockId of scope.blockIds) {
      if (blockIds.has(blockId)) return { kind: "block-id", id: blockId };
      blockIds.add(blockId);
    }
  }
  return undefined;
};
