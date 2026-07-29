export type WorkbenchSurface =
  | { kind: "writing" }
  | { kind: "review" }
  | { kind: "dispatch" }
  | { kind: "connections" }
  | { kind: "settings" };

export type SurfaceTarget = Exclude<WorkbenchSurface["kind"], "writing">;

export type SurfaceEvent =
  | { kind: "open"; target: SurfaceTarget }
  | { kind: "return" }
  | { kind: "documentSelected" };

const writing = (): WorkbenchSurface => ({ kind: "writing" });

/** Keep one visible workbench surface and reject document-only stages without a document. */
export function reduceSurface(
  current: WorkbenchSurface,
  event: SurfaceEvent,
  hasDocument: boolean,
): WorkbenchSurface {
  switch (event.kind) {
    case "return":
    case "documentSelected":
      return writing();
    case "open": {
      if (current.kind === event.target) return writing();
      switch (event.target) {
        case "review":
        case "dispatch":
          return hasDocument ? { kind: event.target } : writing();
        case "connections":
        case "settings":
          return { kind: event.target };
      }
    }
  }
}
