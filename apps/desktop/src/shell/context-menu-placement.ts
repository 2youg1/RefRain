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

/**
 * 版心占视口多宽以内时，菜单必须停在版心外面。
 *
 * 这个数不是审美偏好，是「还剩多少地方可站」的判据：版心占到三分之二以上时
 * 两侧再无容得下一块菜单的空白，此时贴着选区弹出是唯一的选择；窄于这个比例
 * 就一定有一侧放得下，那么压在字上就是没有理由的。
 */
const COLUMN_SHARE_REQUIRING_OVERLAP = 0.67;

const clamp = (value: number, lower: number, upper: number): number =>
  Math.max(lower, Math.min(value, upper));

/**
 * 菜单要让开的那块地方。
 *
 * 只给选区矩形是不够的：让开了选区、正落在下一段上，字一样被挡住，而所有
 * 「不与锚点相交」的断言都仍然为真。所以这里要的是**版心**——作者在读的那
 * 一列文字，不是他刚划中的那几个字。
 */
export interface ContextObstacles {
  /** 选区（或指针）矩形：菜单贴着它出现。 */
  readonly anchor: ContextRectangle;
  /** 正文列。给 null 表示此刻没有正文（例如面板独占舞台）。 */
  readonly column: ContextRectangle | null;
}

const intersects = (placement: ContextMenuPlacement, box: ContextRectangle | null): boolean =>
  box !== null &&
  placement.x < box.right &&
  placement.x + placement.width > box.left &&
  placement.y < box.bottom &&
  placement.y + placement.height > box.top;

/** Place a context workbench beside its selection. Shrink only when the viewport requires it. */
export function placeContextMenu(
  obstacles: ContextObstacles | ContextRectangle,
  pointer: ContextPoint,
  viewport: ContextSize,
  requested: ContextSize,
): ContextMenuPlacement {
  const { anchor, column } =
    "anchor" in obstacles ? obstacles : { anchor: obstacles, column: null };
  const width = Math.min(requested.width, Math.max(1, viewport.width - EDGE * 2));
  const height = Math.min(requested.height, Math.max(1, viewport.height - EDGE * 2));
  const maxX = Math.max(EDGE, viewport.width - width - EDGE);
  const maxY = Math.max(EDGE, viewport.height - height - EDGE);
  const centeredX = clamp(pointer.x - width / 2, EDGE, maxX);
  const centeredY = clamp(pointer.y - height / 2, EDGE, maxY);

  /*
   * 版心两侧的空白够不够站一块菜单。够就先站那儿——那是不挡任何一个字的位置，
   * 而贴着选区的四个方向没有一个能保证这件事。
   */
  const columnShare =
    column === null ? 1 : (column.right - column.left) / Math.max(1, viewport.width);
  if (column !== null && columnShare < COLUMN_SHARE_REQUIRING_OVERLAP) {
    const beside = [column.right + GAP, column.left - width - GAP];
    for (const x of beside) {
      if (x >= EDGE && x + width <= viewport.width - EDGE) {
        return { x, y: centeredY, width, height };
      }
    }
  }

  const candidates: readonly ContextMenuPlacement[] = [
    { x: anchor.right + GAP, y: centeredY, width, height },
    { x: anchor.left - width - GAP, y: centeredY, width, height },
    { x: centeredX, y: anchor.bottom + GAP, width, height },
    { x: centeredX, y: anchor.top - height - GAP, width, height },
  ];
  const inside = (placement: ContextMenuPlacement): boolean =>
    placement.x >= EDGE &&
    placement.x + placement.width <= viewport.width - EDGE &&
    placement.y >= EDGE &&
    placement.y + placement.height <= viewport.height - EDGE;

  /* 先找一个既在视口内、又不压版心的；找不到再退回只求在视口内。 */
  for (const placement of candidates) {
    if (inside(placement) && !intersects(placement, column)) return placement;
  }
  for (const placement of candidates) {
    if (inside(placement)) return placement;
  }
  return { x: centeredX, y: centeredY, width, height };
}
