import { createSignal } from "solid-js";

/**
 * 侧栏此刻滚到哪里、看得见多高。
 *
 * 两个书架都要读它——它们各自按自身 `offsetTop` 算窗口，但共用同一条滚动位置。
 * 放在外壳里就成了外壳的四行状态；它其实只是侧栏的一个事实。
 *
 * `ref` 与 `onScroll` 一并交出，调用方把它们摊到 `<nav>` 上即可，不必自己
 * 记住「量的是 scrollTop 还是 scrollY、高度取 clientHeight 还是 offsetHeight」。
 */
export interface RailScroll {
  readonly top: number;
  readonly height: number;
}

export function railScroll(): {
  readonly view: () => RailScroll;
  readonly ref: (element: HTMLElement) => void;
  readonly onScroll: () => void;
  /**
   * 把焦点交给侧栏（Cmd+2 走这里）。
   *
   * 落在**当前文档那一行**而不是容器上：作者按下去是想在章节之间走，
   * 落在容器上他还得再按一次方向键才知道自己在哪。当前行找不到时退回
   * 第一行，一行都没有时什么也不做——空侧栏上没有可去之处，静默比
   * 把焦点扔进一个空容器诚实。
   */
  readonly focus: () => void;
} {
  const [view, setView] = createSignal<RailScroll>({ top: 0, height: 0 });
  let element: HTMLElement | undefined;
  return {
    view,
    ref: (next) => {
      element = next;
      // 挂上就量一次：容器有高度而窗口还按 0 算的那一帧，作者会看到空侧栏。
      setView({ top: next.scrollTop, height: next.clientHeight });
    },
    onScroll: () => {
      if (element === undefined) return;
      setView({ top: element.scrollTop, height: element.clientHeight });
    },
    focus: () => {
      const target =
        element?.querySelector<HTMLElement>("button.current") ??
        element?.querySelector<HTMLElement>("button");
      target?.focus();
    },
  };
}
