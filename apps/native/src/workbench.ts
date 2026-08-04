/**
 * 工作台的去处：作者此刻在哪，以及哪些去处现在够不着。
 *
 * **接上哪个功能**：步骤 6 的导航、分栏与命令面板。三者问的是同一个问题
 * （「现在该显示什么」），所以它们共用这一个权威，而不是各持一个开关。
 *
 * **在全局逻辑中负责什么**：把「打开了哪些面板」收敛成一个下标。旧前端的
 * 156 处 UI 局部状态正是从「每个面板一个 showX」长出来的——两个布尔值可以
 * 同时为真，于是必须有人记得互斥；一个下标不可能同时是两个值。
 *
 * **能复用什么**：下标同时是导航目标、命令面板的条目与快捷键的落点，
 * 三处不各写一份清单。名字不在这里——中文标签住在 Zig 侧的去处表，
 * 与主题同一条纪律（core 子集不允许非 ASCII 进 rodata，NS9001）。
 */

/** 去处的套数。与 Zig 侧 `workbench_destinations` 的长度同源。 */
export const DESTINATION_COUNT = 8;

/** 稿子。永远够得着，也是一切拒绝的落点。 */
export const DESTINATION_MANUSCRIPT = 0;

/**
 * 需要一份打开的稿子才能进的去处，按下标排成一个位掩码。
 *
 * 位掩码而不是数组：core 子集只折叠数字、字符串与带接口标注的记录表，
 * 一个数字同时表达八条规则，也让「新增去处忘了归类」变成改一个常量的事。
 *
 * 位次对应下标：0 稿子、1 文件、2 裁决、3 派发、4 信箱、5 连接、6 历史、7 设置。
 * 读稿子的是裁决(2)、派发(3)、信箱(4)、历史(6) → 0b0101_1100 = 92。
 */
const NEEDS_DOCUMENT_MASK = 92;

/**
 * 这个去处需要手上有一份打开的稿子吗。
 *
 * 判断放在这里而不是调用点：它是「这个去处是什么」的性质。写在导航里，
 * 命令面板就要抄第二份，而抄漏一项的表现是命令面板能进一个空裁决台。
 */
export function needsDocument(index: number): boolean {
  if (!isDestination(index)) return false;
  return (NEEDS_DOCUMENT_MASK >> index) % 2 === 1;
}

/** 这个数字指向一个真实的去处吗。 */
export function isDestination(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < DESTINATION_COUNT;
}

/**
 * Cmd+1..8 直达：把键位序号翻成去处下标。
 *
 * 收的是数字而不是键名字符串——把 "3" 解析成 3 是平台事件层的事（core 子集
 * 也没有 `Number`）。这里只回答「第几个键对应哪个去处」，不是导航键时返回 −1。
 */
export function destinationForOrdinal(ordinal: number): number {
  const index = ordinal - 1;
  return isDestination(index) ? index : -1;
}

/** 下标钳到一个真实去处。越界回落到稿子——一次坏的选择不该让界面无处可去。 */
export function destinationAt(index: number): number {
  return isDestination(index) ? index : DESTINATION_MANUSCRIPT;
}

/**
 * 一次导航的结果。
 *
 * 三个具名常量而不是「新下标或 null」：拒绝有理由，调用方需要那个理由才能
 * 告诉作者为什么没动。`null` 表达不了「因为你还没打开稿子」。
 */
export const NAVIGATION_MOVED = 1;
/** 已经在那里。不是失败，但也不该重放动画或重发请求。 */
export const NAVIGATION_UNCHANGED = 2;
/** 那个去处需要一份打开的稿子。 */
export const NAVIGATION_NEEDS_DOCUMENT = 3;

/**
 * 算一次导航。不改任何状态——调用方拿结果自己落地。
 *
 * 纯函数是为了让它在 Null platform 上可测：整个步骤 6 的导航规则因此不需要
 * 真窗口就能验红。
 */
export function navigate(current: number, target: number, hasDocument: boolean): number {
  const settled = destinationAt(target);
  if (needsDocument(settled) && !hasDocument) return NAVIGATION_NEEDS_DOCUMENT;
  if (settled === current) return NAVIGATION_UNCHANGED;
  return NAVIGATION_MOVED;
}

/**
 * 换一份稿子（或关掉稿子）之后，当前去处还站得住吗。
 *
 * 换项目等于换了一份稿子的世界：站在裁决台上而稿子已经不在，那个台子上的
 * 每一条都指向不存在的东西。此时退回稿子，而不是留在原地显示空列表。
 */
export function settleAfterDocument(current: number, hasDocument: boolean): number {
  return needsDocument(current) && !hasDocument ? DESTINATION_MANUSCRIPT : destinationAt(current);
}
