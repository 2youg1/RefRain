/**
 * 侧栏何时退开。
 *
 * 作者在写字的时候，指针停在版心不动，侧栏就该让出视野；指针一贴到窗口左缘，
 * 它必须立刻回来。这件事此前住在外壳里，由两个 setTimeout 共用一个 `idleTimer`
 * 变量实现——开场那次「过一会儿就收起」与移动之后那次「停下就收起」是两回事，
 * 挤在同一个变量里，谁清掉谁全看事件次序。
 *
 * 抽出来的另一个理由是它值得被测：涉及时间的行为最容易写错，而计时器由外面注入
 * 之后，这里的每一条规则都可以在没有浏览器、也不必真的等两秒的情况下问清楚。
 */

/** 指针进到这条界线以内，侧栏立刻回来。 */
export const RAIL_SUMMON_X = 28;
/** 指针停在这条界线以外，才认为作者正在版心里写字。 */
export const RAIL_RELEASE_X = 270;
/** 开场停留多久后先收起一次。 */
export const RAIL_FIRST_IDLE_MS = 2_400;
/** 移动之后停多久算停下。 */
export const RAIL_IDLE_MS = 2_000;

/** 排一个一次性的延时任务，返回取消它的方法。 */
export type Timer = (milliseconds: number, task: () => void) => () => void;

export const browserTimer: Timer = (milliseconds, task) => {
  const handle = window.setTimeout(task, milliseconds);
  return () => window.clearTimeout(handle);
};

export class RailPresence {
  #receded = false;
  #cancel: (() => void) | null = null;
  #pointerX = 0;

  constructor(
    private readonly timer: Timer,
    private readonly onChanged: (receded: boolean) => void,
  ) {}

  get receded(): boolean {
    return this.#receded;
  }

  /** 开场：先给作者看一眼侧栏，过一会儿再让开。 */
  begin(): void {
    this.#arm(RAIL_FIRST_IDLE_MS, () => true);
  }

  /**
   * 指针动了。
   *
   * 贴到左缘立刻召回，此时不再排新的计时——作者正伸手过来，两秒后把它收走会
   * 正好赶在他点下去之前。
   */
  pointerMoved(clientX: number): void {
    this.#pointerX = clientX;
    if (clientX < RAIL_SUMMON_X) {
      this.#set(false);
      this.#disarm();
      return;
    }
    if (this.#receded) return;
    this.#arm(RAIL_IDLE_MS, () => this.#pointerX >= RAIL_RELEASE_X);
  }

  /** 拆掉计时器。外壳卸载时调用，否则一个已经消失的界面还会改状态。 */
  dispose(): void {
    this.#disarm();
  }

  #arm(delay: number, shouldRecede: () => boolean): void {
    this.#disarm();
    this.#cancel = this.timer(delay, () => {
      this.#cancel = null;
      if (shouldRecede()) this.#set(true);
    });
  }

  #disarm(): void {
    this.#cancel?.();
    this.#cancel = null;
  }

  #set(receded: boolean): void {
    if (this.#receded === receded) return;
    this.#receded = receded;
    this.onChanged(receded);
  }
}
