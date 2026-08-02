/**
 * 面板的宽度，作者可以用手决定。
 *
 * 三档（surface-width.ts）回答的是「窄一点 / 宽一点 / 铺满」；拖柄回答的是
 * 「就这条缝」。两者不是两个状态，而是同一个状态的两种来路：生效宽度
 * ＝ 拖出来的值 ?? 档位值。换档作废拖动值，因为「选这一档」就是作者要的宽度；
 * 同档重投影（换主题、改排版都会重走 applyAppearance）必须保留拖动值，
 * 否则改一次字号，面板就弹回四百像素——那个复位没有任何一处是作者要求的。
 *
 * 这一个模块拥有与这条宽度有关的一切：当前值、钳制、拖动生命周期（指针捕获、
 * 移动、抬起、Escape 取消）、以及它落到 DOM 上的方式。调用方只剩两句话：
 * 外观投影落地时 `applyPreset`，启动时 `attach`。
 */

import { unwrap } from "../bridge";
import { commands, type PanelWidth } from "../generated/bindings.gen";
import { panelWidthPx } from "./surface-width";

/** 拖动的下限：再窄，设置页的一行控件就排不下。 */
export const PANEL_WIDTH_MIN = 300;
/** 拖动的硬上限。与 surfaces.css 里 `min(720px, 60vw)` 是同一个数（有测试守着）。 */
export const PANEL_WIDTH_MAX = 720;
/** 拖动的视口上限：面板再宽也不许盖过舞台的这个比例。同上，与 CSS 同步。 */
export const PANEL_WIDTH_MAX_VW = 0.6;

const HANDLE_CLASS = "panel-resize-handle";
const RESIZING_CLASS = "panel-resizing";
/** 键盘一次微调的步长。 */
const ARROW_STEP = 16;

/**
 * 把一个想要的宽度钳到合法区间：不小于下限，不大于硬上限与视口比例的较小者。
 * 视口宽度由调用方给，这个函数才能在没有窗口的环境里被问。
 */
export function clampPanelWidth(px: number, viewportPx: number): number {
  const ceiling = Math.min(PANEL_WIDTH_MAX, Math.floor(viewportPx * PANEL_WIDTH_MAX_VW));
  return Math.min(Math.max(Math.round(px), PANEL_WIDTH_MIN), ceiling);
}

/**
 * 一个像素宽度恰好落在哪一档上。「铺满」没有像素值——它由舞台决定，
 * 所以拖到的任何宽度都不会被认成铺满。
 */
export function presetMatchingPx(px: number): PanelWidth | null {
  if (px === panelWidthPx("narrow")) return "narrow";
  if (px === panelWidthPx("regular")) return "regular";
  return null;
}

/**
 * 与 Config 的唯一接缝。
 *
 * 拖到恰好像某一档：写档位（服务端顺手清掉自由值，两种事实归一）。
 * 拖到自由宽度：写 `setPanelWidthPx`，它在服务端覆盖档位直到下一次选档。
 * 不写 localStorage，也不另开存储——verify:config-authority 禁止第二个
 * 设置权威。
 */
export async function persistPanelWidth(px: number): Promise<void> {
  const preset = presetMatchingPx(px);
  if (preset !== null) {
    await unwrap(commands.updatePreferences({ kind: "setPanelWidth", value: preset }));
    return;
  }
  await unwrap(commands.updatePreferences({ kind: "setPanelWidthPx", value: px }));
}

interface DragState {
  readonly pointerId: number;
  readonly handle: HTMLElement;
  /** 拖动开始前的拖动值（null 表示当时跟着档位走）：Escape 与 pointercancel 都回到它。 */
  readonly beforeCustom: number | null;
  /** 面板钉住那条边的 clientX：宽度从这条边量起，而不是从指针起点量。 */
  readonly outer: number;
  /** +1：宽度随 clientX 增大而增大（钉在左边的面板）。-1 相反。 */
  readonly sign: 1 | -1;
}

export class PanelWidthControl {
  #custom: number | null = null;
  #preset: PanelWidth | null = null;
  #presetPx: number | null = null;
  #root: HTMLElement | null = null;
  #observer: MutationObserver | null = null;
  #drag: DragState | null = null;
  /**
   * 面板 → 它的拖柄。拖柄挂在面板的**后面一个兄弟**，不挂在面板里：
   * 面板自己是滚动容器，挂进去的手柄会跟着内容一起滚走（实测滚出视口
   * 一千多像素，指针永远够不到）。同一个层、DOM 序靠后，所以拖柄画在
   * 面板上头而不需要 z-index。
   */
  #handles = new Map<HTMLElement, HTMLElement>();

  /** 生效宽度：拖出来的优先，否则跟随档位。 */
  currentPx(): number {
    return this.#custom ?? this.#presetPx ?? panelWidthPx("regular");
  }

  /**
   * 外观投影每次落地都经过这里。换档作废拖动值；同档重投影保留它。
   * 拖动进行中不换：那一下 config 事件不是作者在拖的同时又选了档，
   * 是别的东西变了（比如主题），没理由打断手上的拖动。
   *
   * `customPx` 是 Config 里持久化的自由宽度。进场规则与「换档作废」同源：
   * 服务端只在选档那一刻清它，所以投影里「档位没变 + 带来 px」才认——
   * 换档投影带过来的 px 是清除前的旧值，不认。null 是「没变」不是
   * 「清除」：拖动写回尚在途中时，一次无关的 config 事件（null）不该把
   * 作者刚拖出来的宽度抹掉。
   */
  applyPreset(root: HTMLElement, preset: PanelWidth, customPx: number | null = null): void {
    this.#root = root;
    const presetChanged = this.#preset !== null && this.#preset !== preset;
    if (this.#drag === null && presetChanged) this.#custom = null;
    if (this.#drag === null && !presetChanged && customPx !== null) this.#custom = customPx;
    this.#preset = preset;
    this.#presetPx = panelWidthPx(preset);
    this.#apply();
  }

  /** 拖动给出的宽度。只记状态并落到 DOM；持久化在拖动结束的那一刻发生一次。 */
  setCustom(px: number): void {
    this.#custom = px;
    this.#apply();
  }

  /** 作者在设置里点了一个档位：拖出来的宽度到这一刻作废。 */
  clearCustom(): void {
    this.#custom = null;
    this.#apply();
  }

  /**
   * 挂上 DOM：给现在与将来的每一个 `[data-quarter]` 面板装上内缘拖柄。
   * 面板是 Solid 随开随关挂出来的，所以用观察器跟着 DOM 走，而不是让
   * 每个面板组件记得自己还有一个把手要装。
   */
  attach(root: HTMLElement): void {
    this.#root = root;
    this.#apply();
    this.#observer?.disconnect();
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches("[data-quarter]")) this.#arm(node);
          for (const panel of node.querySelectorAll("[data-quarter]")) {
            if (panel instanceof HTMLElement) this.#arm(panel);
          }
        }
      }
      // 面板关了，它的拖柄跟着走——没有这一步，手柄会比面板活得还久。
      for (const [panel, handle] of this.#handles) {
        if (!panel.isConnected) {
          handle.remove();
          this.#handles.delete(panel);
        }
      }
    });
    for (const panel of root.querySelectorAll("[data-quarter]")) {
      if (panel instanceof HTMLElement) this.#arm(panel);
    }
    this.#observer.observe(root, { childList: true, subtree: true });
  }

  detach(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#root?.classList.remove(RESIZING_CLASS);
  }

  #apply(): void {
    this.#root?.style.setProperty("--panel-width", `${this.currentPx()}px`);
    // 铺满没有边可拖：那一档的宽度由舞台决定，拖柄藏起来比拖了没反应诚实。
    const hidden = this.#preset === "full";
    for (const handle of this.#root?.querySelectorAll(`.${HANDLE_CLASS}`) ?? []) {
      if (handle instanceof HTMLElement) handle.hidden = hidden;
    }
  }

  #arm(panel: HTMLElement): void {
    if (this.#handles.has(panel)) return;
    const handle = panel.ownerDocument.createElement("div");
    handle.className = HANDLE_CLASS;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "拖动调整面板宽度");
    handle.hidden = this.#preset === "full";
    handle.addEventListener("pointerdown", (event) => this.#begin(panel, handle, event));
    handle.addEventListener("pointermove", (event) => this.#move(event));
    handle.addEventListener("pointerup", (event) => this.#end(event, "commit"));
    handle.addEventListener("pointercancel", (event) => this.#end(event, "revert"));
    handle.addEventListener("keydown", (event) => this.#key(panel, event));
    // 面板的紧后兄弟：同一层、DOM 序靠后，画在面板上头。
    panel.after(handle);
    this.#handles.set(panel, handle);
  }

  /**
   * 面板钉在舞台的哪一边、宽度朝哪个方向长。从矩形量而不从配置读：
   * 钉法（`--panel-offset`、方向）怎么变，这条边都是对的。
   */
  #edge(panel: HTMLElement): { outer: number; sign: 1 | -1 } {
    const rect = panel.getBoundingClientRect();
    const stage = panel.parentElement?.getBoundingClientRect() ?? rect;
    const pinnedLeft = Math.abs(rect.left - stage.left) <= Math.abs(rect.right - stage.right);
    return pinnedLeft ? { outer: rect.left, sign: 1 } : { outer: rect.right, sign: -1 };
  }

  #begin(panel: HTMLElement, handle: HTMLElement, event: PointerEvent): void {
    if (this.#preset === "full" || event.button !== 0) return;
    // 阻止默认，面板里的字才不会在拖动中被选中。
    event.preventDefault();
    // 焦点上手柄，Escape 才落得到这里——落到窗口会被当成「退层」。
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    const { outer, sign } = this.#edge(panel);
    this.#drag = {
      pointerId: event.pointerId,
      handle,
      beforeCustom: this.#custom,
      outer,
      sign,
    };
    // 拖动中关掉入场动画与让位过渡：面板要贴着指针走，不是追在指针后面。
    this.#root?.classList.add(RESIZING_CLASS);
  }

  #move(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    this.setCustom(
      clampPanelWidth(drag.sign * (event.clientX - drag.outer), globalThis.innerWidth),
    );
  }

  #end(event: PointerEvent, outcome: "commit" | "revert"): void {
    const drag = this.#drag;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    this.#root?.classList.remove(RESIZING_CLASS);
    if (drag.handle.hasPointerCapture(event.pointerId)) {
      drag.handle.releasePointerCapture(event.pointerId);
    }
    if (outcome === "revert") {
      this.#custom = drag.beforeCustom;
      this.#apply();
      return;
    }
    // 持久化一次，在结束这一刻；拖动途中不写信道。失败时宽度仍是本机这次的
    // 状态——它只是没写进 Config，不是没发生过，所以不往作者脸上报错。
    void persistPanelWidth(this.currentPx()).catch(() => undefined);
  }

  #key(panel: HTMLElement, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const drag = this.#drag;
      // 只取消这次拖动；不向上冒泡，否则窗口会把它当成「退层」收掉面板。
      if (drag !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (drag.handle.hasPointerCapture(drag.pointerId)) {
          drag.handle.releasePointerCapture(drag.pointerId);
        }
        this.#drag = null;
        this.#root?.classList.remove(RESIZING_CLASS);
        this.#custom = drag.beforeCustom;
        this.#apply();
      }
      return;
    }
    if (this.#drag !== null || this.#preset === "full") return;
    const towardEnd = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (towardEnd === 0) return;
    event.preventDefault();
    // 方向跟着内边走：钉在左边的面板右箭头是变宽，钉在右边的面板相反。
    const { sign } = this.#edge(panel);
    const px = clampPanelWidth(
      this.currentPx() + towardEnd * sign * ARROW_STEP,
      globalThis.innerWidth,
    );
    this.setCustom(px);
    void persistPanelWidth(px).catch(() => undefined);
  }
}

/** 应用里只有一份宽度，接线（App.tsx、ThemePicker、appearance）都拿它。 */
export const panelWidth = new PanelWidthControl();
