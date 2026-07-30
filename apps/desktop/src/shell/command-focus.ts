/**
 * 命令面板拿走焦点之后，把它还回原处。
 *
 * 打开面板的那一刻，作者的光标在某个句子里。关掉面板如果不还焦点，键盘用户会被
 * 丢在文档顶端，回不到刚才写的那句话——而只有「打开」这个动作知道他当时在哪。
 *
 * 有一个陷阱值得写在这里而不是留给调用者：热区在获得焦点时会重新打开面板，
 * 所以把焦点还给热区等于把作者关进一个开合循环。落回手稿是唯一安全的去处。
 */
export class CommandFocus {
  #origin: HTMLElement | null = null;
  #open = false;

  constructor(
    private readonly announce: (open: boolean) => void,
    /** 还不回去时的落点：手稿。 */
    private readonly fallback: () => void,
  ) {}

  get open(): boolean {
    return this.#open;
  }

  show(): void {
    if (this.#open) return;
    this.#origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.#open = true;
    this.announce(true);
  }

  hide(): void {
    if (!this.#open) return;
    const origin = this.#origin;
    this.#origin = null;
    this.#open = false;
    this.announce(false);
    // 微任务：等面板真的从 DOM 上下来，否则焦点会落回一个正在消失的节点。
    queueMicrotask(() => {
      if (origin?.isConnected && !origin.closest(".universal-button-zone")) origin.focus();
      else this.fallback();
    });
  }

  toggle(): void {
    if (this.#open) this.hide();
    else this.show();
  }
}
