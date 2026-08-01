// 饭盒裁决：提案缓慢淡入，点开印点就地展开。
// 原文（划线）/ 提案（可编辑）/ 理由 / Alt A 接受 · Alt E 改后接受 · Alt B 退回。
// 两种布局一个组件：侧挂（默认）与上下文中展开（版心宽过屏宽 66% 时）。
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ProposalDto } from "../generated/bindings.gen";

export type VerdictBentoProps = {
  proposal: ProposalDto;
  /** 原文与划线范围（slice 在块内的起止）。 */
  original: { text: string; start: number; end: number };
  layout: "side" | "inline";
  /** 贴到锚点旁边：top/left 由外壳按块的位置给。 */
  position: { top: number; left: number };
  busy: boolean;
  onAccept: () => void;
  onEditAccept: (finalText: string) => void;
  onReturn: () => void;
  onClose: () => void;
};

export function VerdictBento(props: VerdictBentoProps): JSX.Element {
  const [draft, setDraft] = createSignal(props.proposal.after ?? "");
  const [editing, setEditing] = createSignal(false);
  // 键盘是裁决的主路：挂在窗口上，焦点落在哪都能按（编辑器握着焦点时一样）。
  onMount(() => {
    window.addEventListener("keydown", onKeydown, true);
  });
  onCleanup(() => window.removeEventListener("keydown", onKeydown, true));

  const strike = () => ({
    before: props.original.text.slice(0, props.original.start),
    hit: props.original.text.slice(props.original.start, props.original.end),
    after: props.original.text.slice(props.original.end),
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (!event.altKey) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      props.onAccept();
    } else if (key === "e") {
      event.preventDefault();
      setEditing(true);
    } else if (key === "b") {
      event.preventDefault();
      props.onReturn();
    } else if (key === "enter" && editing()) {
      event.preventDefault();
      props.onEditAccept(draft());
    }
  };

  return (
    <div
      class="verdict-bento"
      classList={{ inline: props.layout === "inline" }}
      role="dialog"
      aria-label="提案裁决"
      style={{ top: `${props.position.top}px`, left: `${props.position.left}px` }}
    >
      <p class="bento-original">
        {strike().before}
        <s>{strike().hit}</s>
        {strike().after}
      </p>
      <Show
        when={editing()}
        fallback={<p class="bento-after">{props.proposal.after ?? "（删除）"}</p>}
      >
        <textarea
          class="bento-editor"
          rows="4"
          aria-label="改后接受的最终文本"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </Show>
      <div class="bento-actions">
        <Show
          when={editing()}
          fallback={
            <>
              <button type="button" disabled={props.busy} onClick={props.onAccept}>
                接受 (Alt A)
              </button>
              <button type="button" disabled={props.busy} onClick={() => setEditing(true)}>
                改后接受 (Alt E)
              </button>
              <button type="button" disabled={props.busy} onClick={props.onReturn}>
                退回 (Alt B)
              </button>
            </>
          }
        >
          <button
            type="button"
            class="primary"
            disabled={props.busy}
            onClick={() => props.onEditAccept(draft())}
          >
            落定 (Alt Enter)
          </button>
          <button type="button" disabled={props.busy} onClick={() => setEditing(false)}>
            返回
          </button>
        </Show>
      </div>
    </div>
  );
}
