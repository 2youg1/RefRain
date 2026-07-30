/**
 * 键盘按下时，这一下归谁。
 *
 * 次序本身就是规矩：Escape 先收右键菜单，菜单收完了才退面板层。反过来的话，
 * 作者开着右键菜单按 Escape 会先掉一层面板，而菜单还浮在那里。
 *
 * 组合期（IME 正在选字）一律不接管——那时的按键属于输入法，不属于我们。
 *
 * 抽出来的另一个理由是它值得被测：快捷键的分支此前只能靠开一个真窗口逐个按，
 * 而这里每一条都可以直接问。
 */

export interface ShortcutTargets {
  /** 正在组合输入。此时所有快捷键让位。 */
  readonly composing: () => boolean;
  readonly save: () => void;
  readonly toggleCommandMenu: () => void;
  /** 右键菜单开着吗。 */
  readonly menuOpen: () => boolean;
  readonly closeMenu: () => void;
  /** 面板栈的深度。0 表示没有打开的面板。 */
  readonly panelDepth: () => number;
  readonly closePanel: () => void;
  /**
   * 按层直达：Cmd+1..4。
   *
   * 传进来的是数字键本身而不是解析好的层，因为「哪个数字是哪一层」归
   * `quarters.ts`，而这里只管「这一下是不是层导航」。
   */
  readonly goToQuarter: (key: string) => boolean;
}

/** 处理了返回 true。返回 true 的那一下已经 preventDefault。 */
export function handleShortcut(event: KeyboardEvent, targets: ShortcutTargets): boolean {
  if (event.isComposing || targets.composing()) return false;
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  const act = (run: () => void): true => {
    event.preventDefault();
    run();
    return true;
  };

  if (modifier && key === "s") return act(targets.save);
  if (modifier && key === "k") return act(targets.toggleCommandMenu);
  // Cmd+1..4 按层直达。放在 Ctrl+[ 之前无所谓——数字与方括号不会撞。
  //
  // `goToQuarter` 返回 false 表示那一层此刻去不了（没有稿子时的编辑层与
  // Agent 层）。这时**不 preventDefault**：这一下没有被我们接管，让它按
  // 浏览器的默认行为走，而不是被静默吃掉。
  if (modifier && /^[1-9]$/.test(event.key)) {
    if (!targets.goToQuarter(event.key)) return false;
    event.preventDefault();
    return true;
  }
  // Ctrl+[ 与 Escape 都是「退一步」，前者给不想离开主键区的手。
  if (modifier && event.key === "[" && targets.panelDepth() > 0) return act(targets.closePanel);
  if (event.key === "Escape") {
    // 先菜单后面板：菜单浮在最上面，作者要收的是它。
    if (targets.menuOpen()) return act(targets.closeMenu);
    if (targets.panelDepth() > 0) return act(targets.closePanel);
  }
  return false;
}
