// 发送信箱的管理页：侧栏放不下的那些在这里，全套邮件管理动作也在这里。
//
// 侧栏那格只挂前几条（MAILBOX_PEEK），因为它同时还得让底部那组全局导航留在
// 屏内。作者要一次处理很多单时来这里：整格全量、分页翻、多选批量。
//
// 弃置在这里同样只是软删除——它退出视线，提案与账本一行不动，回收站那一格
// 把它请回来。
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { Box, MailboxRow, MailboxView } from "../shell/ticket-mailbox";

export type MailboxManagerProps = {
  view: MailboxView;
  box: Box;
  onBox: (box: Box) => void;
  onOpen: (row: MailboxRow, box: Box) => void;
  onMove: (id: string, edge: "top" | "bottom") => void;
  onPin: (ids: readonly string[], pinned: boolean) => void;
  onDiscard: (ids: readonly string[]) => void;
  onRevert: (id: string) => void;
  onClose: () => void;
};

const LABELS: Readonly<Record<Box, string>> = {
  draft: "待发送",
  unread: "已回复",
  done: "已裁决",
};

/** 一页多少行。翻到第一百页仍要能用全部动作，所以分页只切显示，不切能力。 */
export const MANAGER_PAGE_SIZE = 50;

export function MailboxManager(props: MailboxManagerProps): JSX.Element {
  const [page, setPage] = createSignal(0);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [anchor, setAnchor] = createSignal<string | null>(null);

  const rows = createMemo(() => props.view[props.box].all);
  const pages = createMemo(() => Math.max(1, Math.ceil(rows().length / MANAGER_PAGE_SIZE)));
  const visible = createMemo(() => {
    const start = Math.min(page(), pages() - 1) * MANAGER_PAGE_SIZE;
    return rows().slice(start, start + MANAGER_PAGE_SIZE);
  });

  const chosen = (): readonly string[] => [...selected()];

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
      <header class="mailbox-manager-head">
        <h2>发送信箱</h2>
        <nav class="mailbox-manager-tabs">
          <For each={["draft", "unread", "done"] as const}>
            {(box) => (
              <button
                type="button"
                classList={{ "is-current": props.box === box }}
                onClick={() => {
                  props.onBox(box);
                  setPage(0);
                  setSelected(new Set<string>());
                }}
              >
                {LABELS[box]}
                <span class="mailbox-count">{props.view[box].all.length}</span>
              </button>
            )}
          </For>
        </nav>
        <button type="button" class="mailbox-manager-close" onClick={() => props.onClose()}>
          收起
        </button>
      </header>

      {/* 批量动作作用于选中的那些。没选中时它们不可用——一个作用于空集的
          「弃置」按钮只会让人猜它做了什么。 */}
      <div class="mailbox-manager-actions">
        <span class="mailbox-manager-chosen">已选 {selected().size}</span>
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
      </div>

      <ul class="mailbox-manager-rows">
        <For each={visible()}>
          {(row) => (
            <li>
              <button
                type="button"
                class="mailbox-row"
                classList={{ "is-selected": selected().has(row.id), "is-pinned": row.pinned }}
                onClick={(event) => clickRow(event, row)}
                onDblClick={() => props.onOpen(row, props.box)}
              >
                <Show when={row.pinned}>
                  <span class="mailbox-pin" role="img" aria-label="已固定">
                    ◆
                  </span>
                </Show>
                <span class="mailbox-title">{row.title}</span>
                <span class="mailbox-detail">{row.detail}</span>
              </button>
              <span class="mailbox-manager-row-actions">
                <button type="button" onClick={() => props.onMove(row.id, "top")}>
                  置顶
                </button>
                <button type="button" onClick={() => props.onMove(row.id, "bottom")}>
                  置底
                </button>
                <Show when={props.box === "done"}>
                  <button type="button" onClick={() => props.onRevert(row.id)}>
                    回溯
                  </button>
                </Show>
              </span>
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
