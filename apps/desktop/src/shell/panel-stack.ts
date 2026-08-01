/**
 * 面板栈：作者当前打开到哪一层。
 *
 * 界面是一棵树，此刻打开的是从根到叶的一条路径。展开一层是压栈，收起一层是弹栈，
 * 屏幕上并排出现的就是这条路径本身——所以「面包屑」不需要单独维护，它就是栈。
 *
 * 这个结构取代了旧的 `reference: X | null`：那个模型只记得住一层，于是「设置里点开
 * 一个子页」只能靠替换整个值来假装，回退时无处可回。
 *
 * **单向是这个结构的性质，不是样式。** 栈只在一侧生长，所以「另一边不出现任何面板」
 * 不靠纪律维持，它在结构上不可能。翻转方向只是把同一个栈镜像到另一侧渲染——
 * 逻辑一个字都不改，这正是把方向做成设置项而不是第二套代码的原因。
 */

/**
 * 一层面板。
 *
 * `key` 决定同一层里换内容算不算「新的一层」；`content` 是这一层实际显示什么，
 * 由调用方给出。栈不解释它，只负责让它随着这一层一起进来、一起离开——这正是
 * 「打开到哪一层」只有一个权威的意思。
 */
export interface Panel<Content = unknown> {
  readonly key: string;
  readonly content: Content;
}

/** 栈从哪一侧生长。逻辑不看它，只有渲染看。 */
export type PanelSide = "left" | "right";

export class PanelStack<Content = unknown> {
  #layers: readonly Panel<Content>[] = [];

  constructor(private readonly announce: () => void) {}

  get depth(): number {
    return this.#layers.length;
  }

  /** 最外一层，也就是作者正在看的那个。 */
  get top(): Panel<Content> | null {
    return this.#layers.at(-1) ?? null;
  }

  /**
   * 打开一层。
   *
   * 三种情形收在这里，因为它们是同一个问题的三个答案，散给调用者会各写一遍：
   * 已经在顶上 → 关掉它（同一个按钮再按一次就收起，这是作者的预期）；
   * 已经在栈里但不在顶上 → 回到它那一层（不是再开一个副本）；
   * 不在栈里 → 压上去。
   */
  open(panel: Panel<Content>): void {
    const index = this.#layers.findIndex((layer) => layer.key === panel.key);
    // 先判「不在栈里」。空栈时 findIndex 与 length - 1 同为 -1，把这两种情形
    // 交给同一个比较，第一次展开就会被读成「已经在顶上」而当场关掉。
    if (index < 0) {
      this.#set([...this.#layers, panel]);
      return;
    }
    this.#set(this.#layers.slice(0, index === this.#layers.length - 1 ? index : index + 1));
  }

  /** 收起最外一层。Escape 走这里——它退一步，而不是把整棵路径关掉。 */
  back(): void {
    if (this.#layers.length === 0) return;
    this.#set(this.#layers.slice(0, -1));
  }

  /** 回到写作现场。切文档、进 Review 这类换场景的动作走这里。 */
  clear(): void {
    if (this.#layers.length === 0) return;
    this.#set([]);
  }

  #set(next: readonly Panel<Content>[]): void {
    this.#layers = next;
    this.announce();
  }
}
