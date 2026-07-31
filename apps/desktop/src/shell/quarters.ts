/**
 * Quarters are ordered by use frequency: settings, files, editing, then Agent.
 * A higher quarter may coexist with lower quarters. Closing a lower quarter closes those above it.
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

  // Files must persist through cross-quarter drag. Editing and Agent must coexist.
  // Remounting either loses selection, scroll position, and highlighting caches.
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

/** Review owns the stage. Settings and references remain quarters beside the manuscript. */
export function takesWholeStage(scene: { reference: string | null; stage: string }): boolean {
  return scene.stage === "review";
}
