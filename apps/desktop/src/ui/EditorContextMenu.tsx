// 正文右键菜单：菜单必须让开正文——放置逻辑（含贴边翻转）全部交给
// framework-free 的 context-menu-placement，这里只喂锚点与视口，不自己算。
import type { EditorContext, EditorFormat, PunctuationFinding } from "@refrain/editor";
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type ContextMenuPlacement, placeContextMenu } from "../shell/context-menu-placement";

export type EditorContextMenuProps = {
  context: EditorContext;
  pointerX: number;
  pointerY: number;
  kara: boolean;
  relocating: boolean;
  onFormat: (kind: EditorFormat) => void;
  onDeleteEmpty: () => void;
  onPunctuation: (finding: PunctuationFinding) => void;
  onHighlight: () => void;
  onComment: () => void;
  onRelocate: () => void;
  onAccumulate: () => void;
  onClose: () => void;
};

export function EditorContextMenu(props: EditorContextMenuProps): JSX.Element {
  let menu: HTMLDivElement | undefined;
  const [placement, setPlacement] = createSignal<ContextMenuPlacement>({
    x: 12,
    y: 12,
    width: 160,
    height: 184,
  });

  const reposition = (): void => {
    // 有选区时贴着选区矩形；没有选区时退回指针那一点。
    const anchor = props.context.canFormat
      ? props.context.anchor
      : {
          left: props.pointerX,
          right: props.pointerX,
          top: props.pointerY,
          bottom: props.pointerY,
        };
    setPlacement(
      placeContextMenu(
        anchor,
        { x: props.pointerX, y: props.pointerY },
        { width: window.innerWidth, height: window.innerHeight },
        {
          width: 180,
          height: Math.min(
            360,
            40 +
              // 两个分区标签（选区/段落）。
              52 +
              (props.context.canFormat ? 64 : 0) +
              (props.context.canDeleteEmpty ? 32 : 0) +
              (props.context.selection === null ? 0 : props.relocating ? 32 : 64) +
              props.context.punctuation.length * 32 +
              // 「攒进工单」与「取消」。
              64,
          ),
        },
      ),
    );
  };

  const focusFirst = (): void => {
    queueMicrotask(() => menu?.querySelector<HTMLButtonElement>("button")?.focus());
  };

  const buttons = (): HTMLButtonElement[] =>
    menu === undefined ? [] : [...menu.querySelectorAll<HTMLButtonElement>("button")];

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const entries = buttons();
    if (entries.length === 0) return;
    event.preventDefault();
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % entries.length
            : (current - 1 + entries.length) % entries.length;
    entries[target]?.focus();
  };

  // 锚点或指针一变就重新放置并把焦点收回第一项。
  createEffect(() => {
    void props.context;
    void props.pointerX;
    void props.pointerY;
    reposition();
    focusFirst();
  });

  onMount(() => {
    window.addEventListener("resize", reposition);
  });

  onCleanup(() => window.removeEventListener("resize", reposition));

  return (
    <Portal mount={document.body}>
      <div class="context-backdrop" onPointerDown={() => props.onClose()} />
      <div
        ref={menu}
        class="context-menu"
        classList={{ kara: props.kara }}
        role="menu"
        aria-label={props.kara ? "KARA 当前写作操作" : "当前文字操作"}
        style={{
          left: `${placement().x}px`,
          top: `${placement().y}px`,
          width: `${placement().width}px`,
          "max-height": `${placement().height}px`,
        }}
        onKeyDown={onKeydown}
      >
        {/* 选区工具：有选区才出现。 */}
        <Show when={props.context.canFormat}>
          <div class="menu-section" role="presentation">
            选区
          </div>
          <button type="button" role="menuitem" onClick={() => props.onFormat("strong")}>
            加粗
          </button>
          <button type="button" role="menuitem" onClick={() => props.onFormat("emphasis")}>
            斜体
          </button>
        </Show>
        <Show when={props.context.canDeleteEmpty}>
          <button type="button" role="menuitem" onClick={() => props.onDeleteEmpty()}>
            删除空段
          </button>
        </Show>
        <For each={props.context.punctuation}>
          {(finding) => (
            <button type="button" role="menuitem" onClick={() => props.onPunctuation(finding)}>
              {finding.original} → {finding.suggested}
            </button>
          )}
        </For>
        <Show when={props.context.selection !== null && !props.relocating}>
          <button type="button" role="menuitem" onClick={() => props.onHighlight()}>
            建立高亮
          </button>
          <button type="button" role="menuitem" onClick={() => props.onComment()}>
            添加批注
          </button>
        </Show>
        <Show when={props.context.selection !== null && props.relocating}>
          <button type="button" role="menuitem" onClick={() => props.onRelocate()}>
            将批注迁到这里
          </button>
        </Show>
        {/* 段落工具：只记录，不跳走——送出集中在工单台。 */}
        <div class="menu-section" role="presentation">
          段落
        </div>
        <button type="button" role="menuitem" onClick={() => props.onAccumulate()}>
          攒进工单
        </button>
        <button type="button" role="menuitem" onClick={() => props.onClose()}>
          取消
        </button>
      </div>
    </Portal>
  );
}
