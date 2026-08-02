// 历史面板：当前文档的正文行动，新在前；点一行回到「这一步之后」。
//
// 列表状态、两步确认与回档流程都归 shell/history-session.ts——这个组件只做
// 投影：view 给什么就画什么。已撤回的行变灰、不可点；当前位置标出、不可点；
// 其余行第一下点出确认句（会说清要撤回几步），第二下才真的回档。
import { For, type JSX, onCleanup, Show } from "solid-js";
import type { HistoryRow, HistoryView } from "../shell/history-session";

export type HistorySurfaceProps = {
  view: HistoryView;
  onAskRevert: (actionId: string) => void;
  onCancelRevert: () => void;
  onConfirmRevert: () => void;
  onClose: () => void;
};

/** 一行可回档的历史：第一下立确认，确认句说清代价，第二下执行。 */
function HistoryRowView(props: {
  row: HistoryRow;
  confirming: boolean;
  reverting: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <li classList={{ undone: props.row.undone, confirming: props.confirming }}>
      <Show
        when={props.confirming}
        fallback={
          <Show
            when={!props.row.undone && props.row.steps > 0}
            fallback={
              <div class="history-row">
                <span class="cause">{props.row.cause}</span>
                <small>
                  {props.row.undone ? "已撤销" : "当前位置"} · {props.row.time}
                </small>
              </div>
            }
          >
            <button type="button" class="history-row" onClick={() => props.onAsk()}>
              <span class="cause">{props.row.cause}</span>
              <small>{props.row.time}</small>
            </button>
          </Show>
        }
      >
        <p class="revert-confirm">将撤销其后 {props.row.steps} 步，回到这一步之后。</p>
        <div class="revert-actions">
          <button type="button" disabled={props.reverting} onClick={() => props.onConfirm()}>
            {props.reverting ? "正在回档…" : "确认回档"}
          </button>
          <button type="button" disabled={props.reverting} onClick={() => props.onCancel()}>
            取消
          </button>
        </div>
      </Show>
    </li>
  );
}

export function HistorySurface(props: HistorySurfaceProps): JSX.Element {
  // 面板一关，待确认就收回：留着一个上膛的确认给下次打开，是个陷阱。
  onCleanup(() => props.onCancelRevert());
  const rows = () => (props.view.rows.kind === "ready" ? props.view.rows.rows : []);
  return (
    <aside class="history" data-quarter="reference" aria-label="历史">
      <header>
        <div>
          <small>HISTORY</small>
          <h2>历史</h2>
        </div>
        <button type="button" onClick={() => props.onClose()}>
          返回正文
        </button>
      </header>

      <Show when={props.view.dirty && rows().length > 0}>
        <p class="history-hint">「已撤销」标记在下次保存时才会落盘更新。</p>
      </Show>

      <Show
        when={props.view.rows.kind === "ready"}
        fallback={
          <p class="empty">
            {props.view.rows.kind === "loading" ? "正在读取历史…" : "没有打开的文档。"}
          </p>
        }
      >
        <Show when={rows().length > 0} fallback={<p class="empty">这份文档还没有记录到改动。</p>}>
          <ol>
            <For each={rows()}>
              {(row) => (
                <HistoryRowView
                  row={row}
                  confirming={props.view.confirming?.actionId === row.id}
                  reverting={props.view.reverting}
                  onAsk={() => props.onAskRevert(row.id)}
                  onCancel={() => props.onCancelRevert()}
                  onConfirm={() => props.onConfirmRevert()}
                />
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </aside>
  );
}
