/**
 * 名录：一列东西，和作者此刻停在第几行。
 *
 * **接上哪个功能**：步骤 7 的裁决、派发、信箱、连接。四个去处看起来是四张
 * 不同的界面，问的却是同一个问题——「这一列里我停在哪，能不能动，选中的那一
 * 行能做什么」。旧前端为这四张界面写了四套会话类（1,853 行），每套各持一份
 * 游标、各写一遍越界钳制，于是「列表空了游标该去哪」这条规则有四个答案。
 *
 * **在全局逻辑中负责什么**：把游标收成一个不变量——**游标永远指向一个存在的
 * 行，或者在空名录上是 −1**。中间状态不存在，所以调用方不必在每个读取点先
 * 判一次空。名录变短（收走一个 Run、弃置一封信）是这类界面最常见的一次改动，
 * 而它正是「游标指向已消失的行」的来源。
 *
 * **能复用什么**：整个模块与「行里装的是什么」无关——它只认长度与下标，所以
 * 四个去处共用一份，新增第五个去处不必再写一遍。行的内容住在 Zig 侧（中文标
 * 签进不了 core 子集的 rodata，NS9001），与主题色表、去处表同一条纪律。
 */

/** 空名录上的游标。不是 0：0 是一个真实的行，而空名录一行也没有。 */
export const NO_ROW = -1;

/**
 * 把一个游标钳进名录。
 *
 * 三条规则一次答完：空名录得 `NO_ROW`、越界回到最近的一端、其余原样。
 * 「回到最近的一端」而不是回到 0——收走末行时作者的注意力在末尾，把他
 * 弹回第一行是一次他没要求的跳转。
 */
export function settle(cursor: number, count: number): number {
  if (count <= 0) return NO_ROW;
  if (!Number.isInteger(cursor) || cursor < 0) return 0;
  return cursor < count ? cursor : count - 1;
}

/**
 * 上下移动一行。
 *
 * 不绕回：名录是一列，撞到两端就停。绕回会让「按住下键」变成无限循环，
 * 作者读不出自己已经到底了。
 */
export function step(cursor: number, delta: number, count: number): number {
  if (count <= 0) return NO_ROW;
  const from = settle(cursor, count);
  return settle(from + delta, count);
}

/** 这个游标指向一个真实的行吗。命令按钮的可用性读它。 */
export function hasRow(cursor: number, count: number): boolean {
  return count > 0 && cursor >= 0 && cursor < count;
}

/**
 * 名录换了一批内容之后，游标停在哪。
 *
 * **这是本模块存在的理由。** 一次收取、一次弃置、一次裁决都会让名录变短，
 * 而作者的注意力在他刚处理的那一行——不是第一行。停在原位（由 `settle`
 * 钳进新长度）让「连着处理三封」不必每次重新找位置；名录空了才交出 `NO_ROW`。
 */
export function afterRefresh(cursor: number, count: number): number {
  return settle(cursor, count);
}
