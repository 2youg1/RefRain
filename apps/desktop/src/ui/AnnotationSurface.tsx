// 高亮与批注面板：批注是作者的一手材料，不自动附着到相似文字。
// 漂移（drifted）的批注只提示，绝不猜测新位置——迁移必须由作者重新选原文。
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { AnnotationDto } from "../generated/bindings.gen";

export type AnnotationSurfaceProps = {
  annotations: readonly AnnotationDto[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onRelocate: (annotation: AnnotationDto) => void;
  onDispatch: (blockIds: string[], prompt: string) => void;
};

export function AnnotationSurface(props: AnnotationSurfaceProps): JSX.Element {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const comments = createMemo(() => props.annotations.filter((row) => row.kind === "comment"));

  const toggle = (id: string): void => {
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const dispatchSelected = (): void => {
    const rows = comments().filter((row) => selected().has(row.id));
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
    <aside class="annotations" aria-label="高亮与批注">
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
                      checked={selected().has(row.id)}
                      onChange={() => toggle(row.id)}
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
                <div class="actions">
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
          将所选批注转为派发工单
        </button>
      </Show>
    </aside>
  );
}
