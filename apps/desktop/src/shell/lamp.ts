/**
 * A lamp occupies the stratum above the manuscript and below panels.
 * Its position determines the paper highlight, shadow direction, and lit panel edge.
 */

/** 灯的位置，单位是舞台的比例（0 = 左缘，1 = 右缘；纵向 0 = 顶，1 = 底）。 */
export interface LampPlacement {
  /** 横向。单侧灯贴着面板那一侧，全侧灯居中。 */
  readonly x: number;
  /** 纵向。单侧灯与视线齐平，全侧灯在头顶之上（负数表示在舞台之外）。 */
  readonly y: number;
  /** 光照到的范围，同样是舞台比例。超出这个范围就是灯照不到的地方。 */
  readonly reach: number;
  /** 灯的强度，0 到 1。它同时决定亮斑的浓度与影子的深度——一盏灯不会只亮不投影。 */
  readonly power: number;
}

export type LampKind = "off" | "side" | "overhead";

/** 面板开在哪一侧。单侧灯挂在面板那一侧，光横穿舞台。 */
export type PanelSide = "left" | "right";

/**
 * 灯的位置。
 *
 * 单侧灯挂在面板那一侧，与视线齐平（y = 0.42，略高于正中——灯在桌上而不是地上）；
 * 它的 reach 小于 1，因为一盏侧灯照不到对面的角落，而那个照不到的角落正是「光有
 * 位置」这件事唯一能被眼睛读到的证据。
 *
 * 全侧灯在头顶之上（y = -0.15），横向居中，reach 大——顶灯照全场，只是越往下越暗。
 */
export function lampPlacement(kind: LampKind, side: PanelSide): LampPlacement | null {
  if (kind === "off") return null;
  if (kind === "overhead") {
    return { x: 0.5, y: -0.15, reach: 1.15, power: 0.68 };
  }
  return { x: side === "left" ? -0.05 : 1.05, y: 0.42, reach: 0.82, power: 0.9 };
}

/** 灯朝向哪一边（-1 左，1 右，0 无侧向）。样式表用它翻转方向，不必写第二套规则。 */
export function lampFacing(place: LampPlacement): number {
  if (place.x < 0) return 1;
  if (place.x > 1) return -1;
  return 0;
}
