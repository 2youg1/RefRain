/**
 * Debug-window automation plants one path here because it cannot operate a
 * native dialog. Release commands never consume this value; Workbench uses it
 * only to call commands that do not exist in release builds.
 */
export const e2ePickedPath = (): string | null =>
  (window as unknown as Record<string, string | null>)["refrain.e2e.pick"] ?? null;
