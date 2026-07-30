/**
 * 四区。
 *
 * 设置 / 文件 / 编辑 / Agent，自下而上。次序的来由是**使用频率**（KL9 2026-07-30）：
 * 设置很少调整，文件偶尔需要，大部分时候都在自己改稿，而 Agent 会频繁使用。
 *
 * 我最初按依赖推出同一个次序（Agent 引用编辑选中的东西，编辑改文件打开的东西），
 * 但频率论更可靠，差别在后果：依赖论只能说「Agent 需要编辑存在」，频率论说的是
 * **用 Agent 的时候本来就在改稿**——两者同时活跃，不是一个调用另一个。
 *
 * 规矩只有一条，方向不能反：
 *
 *   **上层可以和下层并存，下层不能和上层并存。**
 *
 * 打开 Agent 时编辑留在原处，关掉文件层时其上的编辑与 Agent 一起收走，都由同一条
 * 规矩推出，不是另外加的规则。
 *
 * 频率还决定了每一层在前端怎么活——见 `persistence`，那是这个模块除了层序之外
 * 要回答的第二个问题，也是「常开的东西不能每次重建」这件事的落点。
 *
 * 设计全文见 Memo.md「四区」。
 */

/** 四区，自下而上。数组次序就是层的次序。 */
export const QUARTERS = ["settings", "files", "editing", "agent"] as const;

export type Quarter = (typeof QUARTERS)[number];

/** 层的深浅。设置最浅（0），Agent 最深（3）。 */
export function depth(quarter: Quarter): number {
  return QUARTERS.indexOf(quarter);
}

/** 一个区现在开在哪一侧。主侧是根所在的那一侧，对侧留给上层。 */
export type Side = "main" | "opposite";

export interface OpenQuarter {
  readonly quarter: Quarter;
  readonly side: Side;
}

/**
 * 打开一个区。
 *
 * 下层不动——这是全部立意所在。作者在第七章写到一半想查第三章，若打开文件层会顶掉
 * 编辑状态，他就不敢查，只好凭记忆，然后记错。
 */
export function open(state: readonly OpenQuarter[], quarter: Quarter, side: Side): OpenQuarter[] {
  const kept = state.filter((entry) => entry.quarter !== quarter);
  return [...kept, { quarter, side }].sort((a, b) => depth(a.quarter) - depth(b.quarter));
}

/**
 * 关掉一个区，连同其上的全部。
 *
 * 稿子都关了，「改这一句」和「让 Agent 改这一段」都失去了宾语。这不是顺手清理，
 * 是那条规矩的另一半：下层被收走时，以它为前提的层无法独自成立。
 */
export function close(state: readonly OpenQuarter[], quarter: Quarter): OpenQuarter[] {
  return state.filter((entry) => depth(entry.quarter) < depth(quarter));
}

/**
 * 一个区能不能开到对侧。
 *
 * 只有上层能甩到另一边，下层永远在主侧——它是根。若允许文件层跑到右边而编辑层留在
 * 左边，视觉上就宣称了两者对等，而它们不是。
 *
 * 「最下面那个开着的区」是根：在只开了设置的时候，设置就是根；打开文件之后，
 * 根仍是设置，文件已经可以去对侧。
 */
export function canSendOpposite(state: readonly OpenQuarter[], quarter: Quarter): boolean {
  const root = state[0];
  if (!root) return false;
  return depth(quarter) > depth(root.quarter);
}

/**
 * 同层的东西排在一条线上，不同层的才可以分居两侧。
 *
 * 这条边界要守住，否则「想放哪就放哪」会把层的语义化掉：两份材料是同层，它们该在
 * 面板栈里并列，而不是一左一右假装成两个层级。
 */
export function sideOf(state: readonly OpenQuarter[], quarter: Quarter): Side {
  return state.find((entry) => entry.quarter === quarter)?.side ?? "main";
}

/**
 * 稿子在别处被改了——文件层有权收走其上的层。
 *
 * 这是「下层收走上层」唯一正当的时刻，也说明那条规矩不只是限制，还是授权：
 * 前提没了，以它为前提的东西就该走。
 */
export function invalidate(state: readonly OpenQuarter[], quarter: Quarter): OpenQuarter[] {
  return state.filter((entry) => depth(entry.quarter) <= depth(quarter));
}

/** 键盘按层走：Cmd+1..4 直达。层数少、语义稳，所以这套键位背得下来。 */
export function quarterForKey(key: string): Quarter | null {
  const index = Number(key) - 1;
  return QUARTERS[index] ?? null;
}

/**
 * 一层关掉之后，它的 DOM 该怎么办。
 *
 * 这是频率论对前端实现的硬要求，也是它比依赖论更有用的地方：依赖只说得出层序，
 * 频率说得出**每一层被打开多少次**，而那正好决定重建的代价值不值得付。
 *
 *   "discard" —— 用时才建，关掉即弃。
 *   "keep"    —— 建了就留着，藏起来而不销毁（`display` 切换，不是条件挂载）。
 */
export type Persistence = "discard" | "keep";

export function persistence(quarter: Quarter): Persistence {
  // 设置很少开。常驻一份从不被看的 DOM，等于让它参与每一帧的样式计算。
  if (quarter === "settings") return "discard";

  // 其余三层都留着，各有各的理由：
  //
  // 文件——KL9：「偶尔需要拖文件给 Agent」。拖拽的源必须一直在，否则拖到一半
  //   面板没了。这是跨层操作，两层都得在场。
  //
  // 编辑与 Agent——KL9：「使用 Agent 的时候肯定也需要直接改东西」。两者同时活跃
  //   是常态而非例外。若挂载 Agent 时卸载编辑器，作者每次来回都要付一次编辑器
  //   重建：DOM 重挂、选区丢失、滚动归零、代码高亮缓存作废。
  return "keep";
}

/**
 * 打开这一层会不会让正文重排。
 *
 * 正文在最下面，上面几层的开合只该改变它的**位置**（--panel-reserve），
 * 不该改变它的**度量**（measure）。否则每开一次面板全文重排，而作者正看着的
 * 那一行会跳走——他会把这理解成自己弄丢了位置。
 *
 * 唯一的例外是铺满：那时舞台整个归了面板，正文本就不在视野里。
 */
export function reflowsManuscript(width: "narrow" | "regular" | "full"): boolean {
  return width === "full";
}

/**
 * 哪些场景要占满舞台，正文此刻不在视野里。
 *
 * 设置与逐句裁决曾一起在这里，**那是错的**。四区规矩说设置是第 1 层、正文
 * 在它之上，作者改字号时理应看得见自己的字；而它当时会把正文整行 `display: none`
 * 掉。Memo「四区·边缘情况 5」把这条记为待修，本轮修。
 *
 * 这个判断此前写在组件的 memo 参数里（`kind === "settings" || stage === "review"`），
 * 那是四区的知识落在了渲染代码里：谁占满舞台，取决于层的语义，不取决于谁在渲染。
 *
 * 留下的只有裁决。它不是「一层面板」而是一个场景：作者逐句判断 Agent 的提案时
 * 看不见原文是对的，那正是裁决要做的事——对照的是提案与被提案的那一句，
 * 不是整篇稿子。
 *
 * 注意它与「铺满」不同：铺满是作者选的一档宽度，而这里是场景自身的性质，
 * 作者选不了。
 *
 * `reference` 仍在签名里：调用方问的是「这个场景」而不是「这个 stage」，
 * 而下一个占满舞台的场景很可能由 reference 决定。去掉它会让调用点在那天
 * 改签名，而签名变更要动每一个调用者。
 */
export function takesWholeStage(scene: { reference: string | null; stage: string }): boolean {
  return scene.stage === "review";
}
