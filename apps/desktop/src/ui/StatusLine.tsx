// The 28px status line (SPEC 9.9): save state left, path right. It renders a
// compiled state; it infers nothing.
import { createMemo, For, type JSX, Show } from "solid-js";
import type { RecoveryStep } from "../generated/bindings.gen";
import { RECOVERY_TEXT } from "./recovery-text";

export type SaveState = {
  kind: "clean" | "dirty" | "saving" | "failed";
  reason?: string;
  /** What the author can do about it. Empty when the domain offered nothing. */
  recovery?: readonly RecoveryStep[];
};

export type StatusLineProps = {
  state: SaveState;
  path: string | null;
  /** How much is selected right now, or null when nothing is. */
  selection?: { characters: number; blocks: number } | null;
  /**
   * What is happening right now as one sentence (正在导入资料 / Agent 在途),
   * or null when the line should stay empty. Compiled by the shell from the
   * sessions' working states and the RunWatch; this component infers nothing.
   */
  activity?: string | null;
};

export function StatusLine(props: StatusLineProps): JSX.Element {
  const text = createMemo(() => {
    switch (props.state.kind) {
      case "clean":
        return "已保存";
      case "dirty":
        return "未保存";
      case "saving":
        return "保存中…";
      case "failed":
        return `保存失败：${props.state.reason ?? "未知原因"}`;
    }
  });

  return (
    <footer class="status-line">
      <span class="state" data-kind={props.state.kind}>
        <span class="dot" aria-hidden="true" />
        {text()}
      </span>
      {/* Work in progress: one sentence over a breathing ink line. The sweep
          is the progress — work of unknown duration must not fake a percent. */}
      <Show when={props.activity}>
        {(line) => (
          <span class="activity" role="status">
            <span class="activity-ink" aria-hidden="true" />
            {line()}
          </span>
        )}
      </Show>
      {/* Only on failure, and only when the domain named a way out. A save
          that failed with no recovery says so and stops there rather than
          inventing advice. */}
      <Show when={props.state.kind === "failed" && (props.state.recovery?.length ?? 0) > 0}>
        <span class="recovery" role="status">
          <For each={props.state.recovery}>
            {(step) => <span class="recovery-step">{RECOVERY_TEXT[step]}</span>}
          </For>
        </span>
      </Show>
      {/* 选中反馈放在低干扰的位置：作者不必为了知道选了多少字而离开正文。
          跨段选中时同时报块数——那是他真正在问的问题。 */}
      <Show when={props.selection}>
        {(measure) => (
          <span class="selection" role="status">
            {measure().blocks > 1
              ? `选中 ${measure().characters} 字 · ${measure().blocks} 段`
              : `选中 ${measure().characters} 字`}
          </span>
        )}
      </Show>
      <span class="path">{props.path ?? ""}</span>
    </footer>
  );
}
