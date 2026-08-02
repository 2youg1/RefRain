// 发送信箱管理页的主体：三格的全量、批量动作，以及弃置单的回收站。
//
// 它只管理一页的呈现：列表状态与全部操作归 shell/ticket-mailbox.ts 的
// TicketMailbox（与侧栏那格同一个实例——同一份事实的两种读法）。页面框
// （标题、返回正文）归 MailboxSurface，这里从页签开始。
//
// 弃置在这里同样只是软删除——它退出三格的视线，提案与账本一行不动，回收站
// 那一页把它请回来（取回）。
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { Box, MailboxRow, MailboxView } from "../shell/ticket-mailbox";

/** 管理页的页签：三格之外多一个回收站——弃置的单在那里等取回。 */
export type ManagerBox = Box | "discarded";

export type MailboxManagerProps = {
  view: MailboxView;
  box: ManagerBox;
  onBox: (box: ManagerBox) => void;
  onOpen: (row: MailboxRow, box: Box) => void;
  onMove: (id: string, edge: "top" | "bottom") => void;
  onPin: (ids: readonly string[], pinned: boolean) => void;
  onDiscard: (ids: readonly string[]) => void;
  onRestore: (ids: readonly string[]) => void;
  onRevert: (id: string) => void;
  /** 撤回合并：作用于选中的单里已合并的那些（未合并的被跳过并照实报数）。 */
  onCountermand: (ids: readonly string[]) => void;
};

const TABS: readonly { box: ManagerBox; label: string }[] = [
  { box: "draft", label: "待发送" },
  { box: "unread", label: "已回复" },
  { box: "done", label: "已裁决" },
  { box: "discarded", label: "回收站" },
];

/** 一页多少行。翻到第一百页仍要能用全部动作，所以分页只切显示，不切能力。 */
export const MANAGER_PAGE_SIZE = 50;

/**
 * 撤回合并的那一组按钮：只与已裁决格有关——对判决反悔（历史面板是对编辑
 * 反悔）。两步确认：冲销落的是正文与账本，不给人手滑的机会。
 */
function CountermandAction(props: {
  mergedCount: number;
  arming: boolean;
  onArm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Show
      when={!props.arming}
      fallback={
        <>
          <button type="button" class="is-arming" onClick={props.onConfirm}>
            确认冲销 {props.mergedCount} 单合并
          </button>
          <button type="button" onClick={props.onCancel}>
            取消
          </button>
        </>
      }
    >
      <button
        type="button"
        disabled={props.mergedCount === 0}
        title={props.mergedCount === 0 ? "选中的单没有已合并进正文的" : undefined}
        onClick={props.onArm}
      >
        冲销合并
      </button>
    </Show>
  );
}

/** 一行的动作：三格与回收站各有一套，同一颗按钮不在两格里各写一遍。 */
function ManagerRowActions(props: {
  row: MailboxRow;
  box: ManagerBox;
  onMove: (id: string, edge: "top" | "bottom") => void;
  onRestore: (ids: readonly string[]) => void;
  onRevert: (id: string) => void;
}): JSX.Element {
  return (
    <span class="mailbox-manager-row-actions">
      <Show
        when={props.box !== "discarded"}
        fallback={
          <button type="button" onClick={() => props.onRestore([props.row.id])}>
            取回
          </button>
        }
      >
        <button type="button" onClick={() => props.onMove(props.row.id, "top")}>
          置顶
        </button>
        <button type="button" onClick={() => props.onMove(props.row.id, "bottom")}>
          置底
        </button>
        <Show when={props.box === "done"}>
          <button type="button" onClick={() => props.onRevert(props.row.id)}>
            回溯
          </button>
        </Show>
      </Show>
    </span>
  );
}

export function MailboxManager(props: MailboxManagerProps): JSX.Element {
  const [page, setPage] = createSignal(0);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [anchor, setAnchor] = createSignal<string | null>(null);
  /** 撤回合并的两步确认：第一下上膛，第二下才真的冲销。 */
  const [arming, setArming] = createSignal(false);

  const rows = createMemo(() =>
    props.box === "discarded" ? props.view.discarded : props.view[props.box].all,
  );
  const countOf = (box: ManagerBox): number =>
    box === "discarded" ? props.view.discarded.length : props.view[box].all.length;
  const pages = createMemo(() => Math.max(1, Math.ceil(rows().length / MANAGER_PAGE_SIZE)));
  const visible = createMemo(() => {
    const start = Math.min(page(), pages() - 1) * MANAGER_PAGE_SIZE;
    return rows().slice(start, start + MANAGER_PAGE_SIZE);
  });

  const chosen = (): readonly string[] => [...selected()];
  /** 选中的单里已合并的那些：撤回合并只作用于它们，未合并的照实跳过。 */
  const mergedChosen = (): readonly string[] => {
    const merged = new Set(props.view.done.all.filter((row) => row.merged).map((row) => row.id));
    return chosen().filter((id) => merged.has(id));
  };

  const clickRow = (event: MouseEvent, row: MailboxRow): void => {
    if (event.shiftKey) {
      const start = anchor();
      const list = visible();
      const from = start === null ? -1 : list.findIndex((entry) => entry.id === start);
      const to = list.findIndex((entry) => entry.id === row.id);
      if (from >= 0 && to >= 0) {
        const [low, high] = from <= to ? [from, to] : [to, from];
        setSelected(new Set(list.slice(low, high + 1).map((entry) => entry.id)));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setAnchor(row.id);
      return;
    }
    setSelected(new Set([row.id]));
    setAnchor(row.id);
  };

  return (
    <section class="mailbox-manager">
      <nav class="mailbox-manager-tabs">
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              classList={{ "is-current": props.box === tab.box }}
              onClick={() => {
                props.onBox(tab.box);
                setPage(0);
                setSelected(new Set<string>());
                setArming(false);
              }}
            >
              {tab.label}
              <span class="mailbox-count">{countOf(tab.box)}</span>
            </button>
          )}
        </For>
      </nav>

      {/* 批量动作作用于选中的那些。没选中时它们不可用——一个作用于空集的
          「弃置」按钮只会让人猜它做了什么。回收站的动作只有取回：再弃置一次
          是无操作，固定与排序属于三格的视线，不属于这里。 */}
      <div class="mailbox-manager-actions">
        <span class="mailbox-manager-chosen">已选 {selected().size}</span>
        <Show
          when={props.box !== "discarded"}
          fallback={
            <button
              type="button"
              disabled={selected().size === 0}
              onClick={() => {
                props.onRestore(chosen());
                setSelected(new Set<string>());
              }}
            >
              取回
            </button>
          }
        >
          <button
            type="button"
            disabled={selected().size === 0}
            onClick={() => props.onPin(chosen(), true)}
          >
            固定
          </button>
          <button
            type="button"
            disabled={selected().size === 0}
            onClick={() => props.onPin(chosen(), false)}
          >
            取消固定
          </button>
          <button
            type="button"
            disabled={selected().size === 0}
            onClick={() => {
              props.onDiscard(chosen());
              setSelected(new Set<string>());
            }}
          >
            弃置
          </button>
          <Show when={props.box === "done"}>
            <CountermandAction
              mergedCount={mergedChosen().length}
              arming={arming()}
              onArm={() => setArming(true)}
              onConfirm={() => {
                props.onCountermand(mergedChosen());
                setArming(false);
                setSelected(new Set<string>());
              }}
              onCancel={() => setArming(false)}
            />
          </Show>
        </Show>
      </div>

      <ul class="mailbox-manager-rows">
        <For each={visible()}>
          {(row) => (
            <li
              classList={{ "is-unmerged": props.box === "done" && !row.merged }}
              title={
                props.box === "done" && !row.merged
                  ? "未曾合并进正文（已退回、仍在批次、或已冲销）"
                  : undefined
              }
            >
              <button
                type="button"
                class="mailbox-row"
                classList={{ "is-selected": selected().has(row.id), "is-pinned": row.pinned }}
                onClick={(event) => clickRow(event, row)}
                onDblClick={() => {
                  // 回收站的行没有「去裁决」：它已经退出三格，先取回才有去向。
                  if (props.box !== "discarded") props.onOpen(row, props.box);
                }}
              >
                <Show when={row.pinned}>
                  <span class="mailbox-pin" role="img" aria-label="已固定">
                    ◆
                  </span>
                </Show>
                <span class="mailbox-title">{row.title}</span>
                <span class="mailbox-detail">{row.detail}</span>
              </button>
              <ManagerRowActions
                row={row}
                box={props.box}
                onMove={props.onMove}
                onRestore={props.onRestore}
                onRevert={props.onRevert}
              />
            </li>
          )}
        </For>
      </ul>

      <footer class="mailbox-manager-pager">
        <button type="button" disabled={page() === 0} onClick={() => setPage((n) => n - 1)}>
          上一页
        </button>
        <span>
          第 {Math.min(page(), pages() - 1) + 1} / {pages()} 页
        </span>
        <button
          type="button"
          disabled={page() >= pages() - 1}
          onClick={() => setPage((n) => n + 1)}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
