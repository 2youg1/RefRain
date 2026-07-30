export interface ContextRectangle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ContextPoint {
  readonly x: number;
  readonly y: number;
}

export interface ContextSize {
  readonly width: number;
  readonly height: number;
}

export interface ContextMenuPlacement extends ContextSize {
  readonly x: number;
  readonly y: number;
}

const EDGE = 12;
const GAP = 10;

const clamp = (value: number, lower: number, upper: number): number =>
  Math.max(lower, Math.min(value, upper));

/** Place a context workbench beside its selection. Shrink only when the viewport requires it. */
export function placeContextMenu(
  anchor: ContextRectangle,
  pointer: ContextPoint,
  viewport: ContextSize,
  requested: ContextSize,
): ContextMenuPlacement {
  const width = Math.min(requested.width, Math.max(1, viewport.width - EDGE * 2));
  const height = Math.min(requested.height, Math.max(1, viewport.height - EDGE * 2));
  const maxX = Math.max(EDGE, viewport.width - width - EDGE);
  const maxY = Math.max(EDGE, viewport.height - height - EDGE);
  const centeredX = clamp(pointer.x - width / 2, EDGE, maxX);
  const centeredY = clamp(pointer.y - height / 2, EDGE, maxY);
  const right = anchor.right + GAP;
  const left = anchor.left - width - GAP;
  const below = anchor.bottom + GAP;
  const above = anchor.top - height - GAP;

  if (right + width <= viewport.width - EDGE) {
    return { x: right, y: centeredY, width, height };
  }
  if (left >= EDGE) {
    return { x: left, y: centeredY, width, height };
  }
  if (below + height <= viewport.height - EDGE) {
    return { x: centeredX, y: below, width, height };
  }
  if (above >= EDGE) {
    return { x: centeredX, y: above, width, height };
  }
  return { x: centeredX, y: centeredY, width, height };
}
