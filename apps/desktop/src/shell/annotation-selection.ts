/**
 * 作者勾选了哪些批注要交给 Agent。
 *
 * 这件事此前是 `AnnotationSurface` 里的一个组件本地信号，于是它随面板一起
 * 生死：作者勾了十条批注，想回正文核对一句话，关掉面板再打开——**十条勾选
 * 全没了**，面板是空的，没有任何提示。他会以为自己没点，重勾一遍。
 *
 * 那正是 KL9 的 ADHD 判据里点名的失败形态：「任何重复功能按键都会导致愤怒」。
 *
 * 移出来的判据不是行数，是归属：**选择是作者的意图，不是面板的显示状态**。
 * 面板关掉时消失的应该是面板，不是他刚做的决定。`quarters.ts` 的 `persistence`
 * 说第 2/3/4 层「藏起来而不销毁」，说的也是同一件事——只不过那管的是 DOM，
 * 这管的是意图，而意图比 DOM 更不该被一次收起抹掉。
 *
 * 顺带它第一次可测：组件本地信号只能靠开一个真窗口点几下来验证。
 */

/** 一条批注在这次选择里的身份。只需要 id，其余从投影里读。 */
export type AnnotationId = string;

export class AnnotationSelection {
  #selected: ReadonlySet<AnnotationId> = new Set();

  constructor(private readonly announce: () => void) {}

  get selected(): ReadonlySet<AnnotationId> {
    return this.#selected;
  }

  get count(): number {
    return this.#selected.size;
  }

  has(id: AnnotationId): boolean {
    return this.#selected.has(id);
  }

  /** 勾上或取消。同一个按键两种意思，因为作者看到的就是一个复选框。 */
  toggle(id: AnnotationId): void {
    const next = new Set(this.#selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.#set(next);
  }

  /**
   * 派发之后清空。
   *
   * 只有这一个时刻该清：作者的意图已经交出去了，留着会让他下一次派发时
   * 带上一批已经处理过的批注。关面板、切层、换主题都不清——那些是显示，
   * 不是他改变了主意。
   */
  clear(): void {
    if (this.#selected.size === 0) return;
    this.#set(new Set());
  }

  /**
   * 丢掉已经不存在的批注。
   *
   * 批注可能在别处被删掉（作者在正文里删了那段，或另一个视图里删了批注）。
   * 选择必须跟着放手，否则派发会带上一个取不到引文的 id，而失败发生在
   * 派发那一刻——离作者做这个选择已经很远了。
   *
   * 只在真的少了东西时广播：每次投影更新都广播会让面板每帧重绘。
   */
  retain(alive: Iterable<AnnotationId>): void {
    const living = new Set(alive);
    const next = new Set([...this.#selected].filter((id) => living.has(id)));
    if (next.size === this.#selected.size) return;
    this.#set(next);
  }

  #set(next: ReadonlySet<AnnotationId>): void {
    this.#selected = next;
    this.announce();
  }
}
