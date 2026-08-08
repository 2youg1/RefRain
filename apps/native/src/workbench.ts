/**
 * 工作台的去处与导航：作者此刻在哪，以及「这一下按键归谁」。
 *
 * **接上哪个功能**：导航（Cmd+1..8）、面板开合（Escape 退层、同键再按关闭）、
 * 命令面板与分栏。它们问的是同一个问题（「现在该显示什么」），所以共用
 * 这一个权威。
 *
 * **舞台规则（写死，ARCHITECTURE.md「The stage rule」同文）**：正文是唯一
 * 的舞台。交互区只有两个，不许出现第三个——
 * 1. **单侧功能区**：一切工具表面（文件/裁决/派发/信箱/连接/历史/设置）
 *    从同一侧以面板进出，按层深叠放；工具不开在正文之上。
 * 2. **右键编辑区**：文本动作落在文本上——右键菜单与键位；鼠标停在字上。
 *    就地锚点（右键菜单、提案印点、裁决饭盒）附着在它作用的那一行，是
 *    编辑区的词汇，不是浮窗。
 * 正文层之上不许有新 UI/浮窗。豁免只有两个且永远只有两个：Agent 状态
 * 恢复卡（KARA「你停在这里」）与作者自己要的全屏设置。第三个浮层是
 * 缺陷，不是功能。表面必须渐进、引导式：任务叫到才出现一层；每层把
 * 自己的键位印在按钮上（菜单教会键位，键位替代鼠标）；Escape 一次只关
 * 一层，最内层先关。三条具体化（作者 2026-08-07 补）：
 * 1. **命令面板住进功能区、树状排列**——不是浮层，与文件树同款树；
 *    深度渐进披露（skill 的 SKILL.md 同款：摘要在前，细节展开才见）；
 *    每个功能同此待遇：简路径可见，全深度在一次展开之外，从不在一个
 *    窗口之外。
 * 2. **鼠标与键盘两条路都是一等公民**——鼠标单独能走通一切且永远
 *    不用大范围移动（目标在正读的文字上或手边的功能区里）；键盘也能
 *    走通一切且每个键位都被界面教过。需要大范围移动鼠标的流程是缺陷，
 *    需要界面从没教过的键位的流程也是缺陷。
 * 3. **一次一层**——开一层不顶替正在读的内容（功能区叠在旁、编辑区
 *    附着在行）；关上精确回到之前的状态。
 *
 * **模型**（V0.2.4 四区 + 面板栈语义，收敛进八去处互斥导航）：
 * - 去处仍是唯一下标（一个下标不可能同时是两个值），但下标可沿两条轴走：
 *   **四区键位**（Cmd+1..4，旧版 quarters）与**直达键位**（Cmd+5..8，原生肌肉记忆）。
 * - 四区 = 设置 / 文件 / 编辑 / Agent。Agent 区记忆上次去处（旧版
 *   QuarterMemory）：按 Cmd+4 回到上次 Agent 去处，而不是某个默认值。
 * - 面板栈退化成「上一个去处」：Escape 回上一个去处（旧版 `back`），
 *   同键再按关闭当前去处（旧版 `open` 的「已在顶上→关」）。
 *
 * **能复用什么**：下标同时是导航目标、命令面板条目与快捷键落点；
 * 分栏的 fraction 也是同一张表的纯函数（渲染不各猜一次）。
 */

/** 去处的套数。与 Zig 侧 `workbench_destinations` 的长度同源。 */
export const DESTINATION_COUNT = 8;

/** 稿子。永远够得着，也是一切拒绝的落点。 */
export const DESTINATION_MANUSCRIPT = 0;

/** 文件（侧栏）。四区的「文件」指的就是它。 */
export const DESTINATION_FILES = 1;

/** 裁决台。Alt 裁决键的路由读它：那些键只在台上才动作。 */
export const DESTINATION_REVIEW = 2;

/** 派发。Agent 区与 Cmd+4 的默认落点（与旧版 QuarterMemory 默认批注不同：原生没有批注面板，派发是 Agent 层最常去的台子）。 */
export const DESTINATION_DISPATCH = 3;

/** 设置。四区的「设置」指的就是它。 */
export const DESTINATION_SETTINGS = 7;

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

/** 这个去处需要手上有一份打开的稿子吗。 */
export function needsDocument(index: number): boolean {
  if (!isDestination(index)) return false;
  return (NEEDS_DOCUMENT_MASK >> index) % 2 === 1;
}

/** 这个数字指向一个真实的去处吗。 */
export function isDestination(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < DESTINATION_COUNT;
}

/**
 * 四区键位：Cmd+1..4，与旧版 quarters 同序（设置/文件/编辑/Agent）。
 *
 * 收的是键位序号（Cmd+1 是 1）。不是四区也不是直达键时返回 −1——
 * 调用方据此决定这一下不该被接管（旧版 shortcuts 的同一条规矩：
 * 去不了的那一下不 preventDefault，让平台默认行为走）。
 */
export function destinationForOrdinal(ordinal: number, agentDestination: number): number {
  switch (ordinal) {
    case 1:
      return DESTINATION_SETTINGS;
    case 2:
      return DESTINATION_FILES;
    case 3:
      return DESTINATION_MANUSCRIPT;
    case 4:
      return isDestination(agentDestination) ? agentDestination : DESTINATION_DISPATCH;
  }
  const direct = ordinal - 1;
  return isDestination(direct) ? direct : -1;
}

/** 下标钳到一个真实去处。越界回落到稿子——一次坏的选择不该让界面无处可去。 */
export function destinationAt(index: number): number {
  return isDestination(index) ? index : DESTINATION_MANUSCRIPT;
}

/** 这个去处属于 Agent 层吗（Cmd+4 会记住它）。 */
export function isAgentDestination(index: number): boolean {
  switch (index) {
    case 2: // 裁决
    case 3: // 派发
    case 4: // 信箱
    case 5: // 连接
    case 6: // 历史
      return true;
  }
  return false;
}

/**
 * 这个去处有一份名录吗（上下移动有意义）：裁决、派发、信箱、连接。
 *
 * 名录键（Ctrl+J/K 与 Alt+J/K）按它接管：在没有名录的去处上移动一个
 * 看不见的游标，等作者回到台上时位置已经漂了——那是「键没生效」与
 * 「键偷偷生效」两种困惑的来源。
 */
export function hasRoster(index: number): boolean {
  switch (index) {
    case 2: // 裁决
    case 3: // 派发
    case 4: // 信箱
    case 5: // 连接
      return true;
  }
  return false;
}

/**
 * 一次导航的结果。
 *
 * 四个具名常量而不是「新下标或 null」：拒绝有理由，调用方需要那个理由才能
 * 告诉作者为什么没动。
 */
export const NAVIGATION_MOVED = 1;
/** 已经在那里。不是失败，但也不该重放动画或重发请求。 */
export const NAVIGATION_UNCHANGED = 2;
/** 那个去处需要一份打开的稿子。 */
export const NAVIGATION_NEEDS_DOCUMENT = 3;
/** 同键再按：旧版面板栈「已在顶上→关」。回稿子。 */
export const NAVIGATION_CLOSE = 4;

/**
 * 算一次导航。不改任何状态——调用方拿结果自己落地。
 *
 * 纯函数是为了让它在 Null platform 上可测：整个导航规则因此不需要真窗口
 * 就能验红。同键再按是「关闭」而非「不动」：作者在批注里按 Cmd+4 再按一次
 * 想回的是正文，不是同一个面板再看一遍。
 */
export function navigate(current: number, target: number, hasDocument: boolean): number {
  const settled = destinationAt(target);
  if (needsDocument(settled) && !hasDocument) return NAVIGATION_NEEDS_DOCUMENT;
  if (settled === current) {
    // 稿子本身没有再按一次的关闭语义：回到稿子就是留在稿子。
    return settled === DESTINATION_MANUSCRIPT ? NAVIGATION_UNCHANGED : NAVIGATION_CLOSE;
  }
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

/**
 * 分栏的第一 pane 占比（0..1）。
 *
 * 渲染把「去处」投影成分栏宽度，这一张表就是那个投影的唯一权威——渲染不各猜
 * 一次。语义与旧版同源：**一切从单侧（左）出现**，正文恒在最右——
 * Rail（文件）最左，面板贴着它展开（旧版 panel 的 inset-inline-start 同侧），
 * 右键菜单与 notice 是仅有的两个浮在正文上的东西（UI 极简主义）。
 *
 * - 稿子：正文全宽。
 * - 裁决：独占舞台（旧版 takesWholeStage，正文整屏让位）。
 * - 文件：侧栏 19% ≈ 248px/1280px，正文在右。
 * - 其余去处：面板 32% ≈ 400px/1280px 在左，正文让到右。
 */
export function layoutFraction(index: number, railFraction: number): number {
  switch (index) {
    case DESTINATION_MANUSCRIPT:
    case 2: // 裁决
      return 1.0;
    case DESTINATION_FILES:
      return railFraction;
  }
  return 0.32;
}

/** 侧栏默认宽：248px / 1280px ≈ 0.19。与旧版 --rail-width 同源。 */
export const RAIL_FRACTION_DEFAULT = 0.19;

/** 侧栏宽的可调区间（拖柄钳制，旧版 panel-width 的 clamp 同族）。 */
export function clampRailFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return RAIL_FRACTION_DEFAULT;
  return Math.min(0.4, Math.max(0.1, fraction));
}

/**
 * 面板栈：去处切换的退层记忆（旧版 PanelStack）。
 *
 * 一个 number 编码 8 层 × 每层 3 bit（去处 0..7），低 3 位是栈底。
 * 数字编码而不是数组：core 子集只折叠数字与固定记录，数组进不了 Model。
 * 栈只记「非稿子」的去处——稿子(0) 是根，不在栈里。
 */
export const PANEL_STACK_EMPTY = 0;

export const PANEL_STACK_MAX_DEPTH = 8;

/** 栈顶去处；空栈返回稿子（根）。 */
export function peekStack(stack: number): number {
  const depth = stackDepth(stack);
  return depth === 0 ? DESTINATION_MANUSCRIPT : destinationAt((stack >> ((depth - 1) * 3)) % 8);
}

export function stackDepth(stack: number): number {
  if (!Number.isInteger(stack) || stack <= 0) return 0;
  let depth = 0;
  let rest = stack;
  while (rest > 0 && depth < PANEL_STACK_MAX_DEPTH) {
    // >> 3 是整数除 8（2^3）——除号会流进小数槽（NS1016）。
    rest = rest >> 3;
    depth = depth + 1;
  }
  return depth;
}

/** 前进到某处：压栈（去处是稿子时不动——根不进栈）。 */
export function pushStack(stack: number, destination: number): number {
  if (destination === DESTINATION_MANUSCRIPT) return stack;
  const depth = stackDepth(stack);
  if (depth >= PANEL_STACK_MAX_DEPTH) return stack;
  // 位移而不是 Math.pow：core 子集的整数槽不允许小数流进来（NS1016）。
  return stack + destination * (1 << (depth * 3));
}

/**
 * 弹栈的两半（core 子集不折叠无接口标注的对象字面量，所以拆成两个数字
 * 函数而不是一个返回记录）：
 * - `popDestination`：栈顶去处（空栈=稿子）。
 * - `popRest`：弹掉栈顶后剩下的栈。
 */
export function popDestination(stack: number): number {
  const depth = stackDepth(stack);
  if (depth === 0) return DESTINATION_MANUSCRIPT;
  return destinationAt((stack >> ((depth - 1) * 3)) % 8);
}

export function popRest(stack: number): number {
  const depth = stackDepth(stack);
  if (depth === 0) return stack;
  return stack % (1 << ((depth - 1) * 3));
}

/**
 * 多层面板栈（2.9）：栈从退层记忆升格为可见层——面板从单侧（左）依次
 * 排开，栈底最左、当前层最右。本区函数只回答「哪几层可见、各是谁」；
 * 像素几何（面板宽、reserve、translateX）归 Zig 的 `panel_stack.zig`。
 */

/** 独占舞台的去处：稿子与裁决。它们打开时盖住所有层（层留在栈里）。 */
export function isWholeStage(index: number): boolean {
  return index === DESTINATION_MANUSCRIPT || index === DESTINATION_REVIEW;
}

/** 可见面板层数上限（含当前层）。更旧的层留在栈里，只是不画。 */
export const MAX_VISIBLE_LAYERS = 3;

/** 栈里第 depth 层的去处（0 = 栈底）。越界返回稿子（根）。 */
export function layerAt(stack: number, depth: number): number {
  if (depth < 0 || depth >= stackDepth(stack)) return DESTINATION_MANUSCRIPT;
  return destinationAt((stack >> (depth * 3)) % 8);
}

/**
 * 可见层数。当前层是独占去处时为 0（它盖住一切）；否则是栈里的面板层
 * （独占层不算面板）与当前面板层的总数，夹到上限。
 */
export function visibleDepth(stack: number, current: number): number {
  if (isWholeStage(current)) return 0;
  let panels = 0;
  const depth = stackDepth(stack);
  for (let index = 0; index < depth; index += 1) {
    if (!isWholeStage(layerAt(stack, index))) panels += 1;
  }
  return Math.min(panels + 1, MAX_VISIBLE_LAYERS) | 0;
}

/**
 * 可见的第 i 层（0 = 最左）是哪个去处。栈里的面板层按从底到顶排，
 * 当前层恒在最右；超出上限时最旧的层先藏起来。
 */
export function visibleLayerAt(stack: number, current: number, at: number): number {
  const depth = visibleDepth(stack, current);
  if (at < 0 || at >= depth) return destinationAt(current);
  if (at === depth - 1) return destinationAt(current);
  // 先数出栈里有几个面板层，再按窗口（只露最新的几层）取第 at 个。
  let panels = 0;
  const total = stackDepth(stack);
  for (let index = 0; index < total; index += 1) {
    if (!isWholeStage(layerAt(stack, index))) panels += 1;
  }
  const window = depth - 1; // 当前层占掉最后一席
  const skip = Math.max(0, panels - window);
  let seen = 0;
  for (let index = 0; index < total; index += 1) {
    const layer = layerAt(stack, index);
    if (isWholeStage(layer)) continue;
    if (seen < skip) {
      seen += 1;
      continue;
    }
    if (seen === skip + at) return layer;
    seen += 1;
  }
  return destinationAt(current);
}
