// The 28px status line (SPEC 9.9): save state left, path right. It renders a
// compiled state; it infers nothing.
import { createMemo, type JSX } from "solid-js";

export type SaveState = {
  kind: "clean" | "dirty" | "saving" | "failed";
  reason?: string;
};

export type StatusLineProps = {
  state: SaveState;
  path: string | null;
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
        return `保存失败:${props.state.reason ?? "未知原因"}`;
    }
  });

  return (
    <footer class="status-line">
      <span class="state" data-kind={props.state.kind}>
        <span class="dot" aria-hidden="true" />
        {text()}
      </span>
      <span class="path">{props.path ?? ""}</span>
    </footer>
  );
}

export default StatusLine;
