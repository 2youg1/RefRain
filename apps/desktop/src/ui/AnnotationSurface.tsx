// 高亮与批注面板：批注是作者的一手材料，不自动附着到相似文字。
// 漂移（drifted）的批注只提示，绝不猜测新位置——迁移必须由作者重新选原文。
import { createMemo, For, type JSX, Show } from "solid-js";
import type { AnnotationDto } from "../generated/bindings.gen";

export type AnnotationSurfaceProps = {
  annotations: readonly AnnotationDto[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onRelocate: (annotation: AnnotationDto) => void;
  onDispatch: (blockIds: string[], prompt: string) => void;
  /**
   * 作者勾了哪些批注。
   *
   * 由外壳持有而不是这个组件自己记：面板一关组件就没了，而作者的选择不该
   * 跟着没。他勾了十条、回正文核对一句、再打开面板——那十条必须还在。
   */
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
};

export function AnnotationSurface(props: AnnotationSurfaceProps): JSX.Element {
  const comments = createMemo(() => props.annotations.filter((row) => row.kind === "comment"));

  const dispatchSelected = (): void => {
    const rows = comments().filter((row) => props.selected.has(row.id));
    if (rows.length === 0) return;
    const blockIds = [...new Set(rows.map((row) => row.blockId))];
    const prompt = rows
      .map((row, index) => `${index + 1}. ${row.body ?? ""}\n引文：${row.quote}`)
      .join("\n\n");
    props.onDispatch(
      blockIds,
      `请处理以下作者批注；保留为提案，未经作者裁决不要改入正文。\n\n${prompt}`,
    );
  };

  return (
    <aside class="annotations" data-quarter="agent" aria-label="高亮与批注">
      <header>
        <div>
          <small>ANNOTATIONS</small>
          <h2>高亮与批注</h2>
        </div>
        <button type="button" onClick={() => props.onClose()}>
          返回正文
        </button>
      </header>

      <Show
        when={props.annotations.length > 0}
        fallback={<p class="empty">选择正文后右键，可建立高亮或批注。</p>}
      >
        <ol>
          <For each={props.annotations}>
            {(row) => (
              <li classList={{ drifted: row.anchorState === "drifted" }}>
                <Show when={row.kind === "comment"}>
                  <label>
                    <input
                      type="checkbox"
                      checked={props.selected.has(row.id)}
                      onChange={() => props.onToggle(row.id)}
                    />
                    选入派发
                  </label>
                </Show>
                <small>
                  {row.kind === "highlight" ? "高亮" : "批注"} · {row.blockId}
                </small>
                <blockquote>{row.quote}</blockquote>
                <Show when={row.body}>
                  <p>{row.body}</p>
                </Show>
                <Show when={row.anchorState === "drifted"}>
                  <p class="warning">
                    原文已经移动。此批注不会自动附着到相似文字；请重新选择准确原文后迁移。
                  </p>
                </Show>
                <div class="annotation-actions">
                  <Show when={row.anchorState === "drifted"}>
                    <button type="button" onClick={() => props.onRelocate(row)}>
                      重新选择原文
                    </button>
                  </Show>
                  <button type="button" onClick={() => props.onDelete(row.id)}>
                    删除
                  </button>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={comments().length > 0}>
        <button type="button" class="dispatch" onClick={dispatchSelected}>
          将所选批注转为派发发送
        </button>
      </Show>
    </aside>
  );
}
