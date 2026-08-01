// 工单信箱的树：待发送 / 未读（徽标计数）/ 已处理 三格，可折叠。
// 右键一单：置顶、置底、回溯（已处理格）——没有全屏跳转。
import { createSignal, For, type JSX, Show } from "solid-js";
import type { MailboxRow, MailboxView } from "../shell/ticket-mailbox";

export type MailboxBox = "draft" | "unread" | "done";

export type TicketMailboxPanelProps = {
  view: MailboxView;
  /** 点开一单：去它该在的地方（草稿→工单台，其余→逐句裁决）。 */
  onOpen: (row: MailboxRow, box: MailboxBox) => void;
  onMove: (id: string, edge: "top" | "bottom") => void;
  onRevert: (id: string) => void;
};

const GROUPS: readonly { box: MailboxBox; label: string }[] = [
  { box: "draft", label: "待发送" },
  { box: "unread", label: "未读" },
  { box: "done", label: "已处理" },
];

export function TicketMailboxPanel(props: TicketMailboxPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<MailboxBox>>(new Set());
  const [menu, setMenu] = createSignal<{
    row: MailboxRow;
    box: MailboxBox;
    x: number;
    y: number;
  } | null>(null);

  const toggle = (box: MailboxBox): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(box)) next.delete(box);
      else next.add(box);
      return next;
    });
  };

  const rowsOf = (box: MailboxBox): readonly MailboxRow[] => props.view[box];

  return (
    <div class="mailbox" onPointerLeave={() => setMenu(null)}>
      <div class="rail-group">
        工单信箱
        <Show when={props.view.unreadCount > 0}>
          <span class="mailbox-badge">{props.view.unreadCount}</span>
        </Show>
      </div>
      <For each={GROUPS}>
        {(group) => (
          <section class="mailbox-group">
            <button type="button" class="mailbox-head" onClick={() => toggle(group.box)}>
              {/* 三角挂在缩进槽里，标签才与同级的文档行对齐——它跟着标签走就会把标签推右。 */}
              <span class="mailbox-twist">{collapsed().has(group.box) ? "▸" : "▾"}</span>
              {group.label}
              <span class="mailbox-count">{rowsOf(group.box).length}</span>
            </button>
            <Show when={!collapsed().has(group.box)}>
              <ul>
                <For each={rowsOf(group.box)}>
                  {(row) => (
                    <li>
                      <button
                        type="button"
                        class="mailbox-row"
                        onClick={() => props.onOpen(row, group.box)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setMenu({ row, box: group.box, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <span class="mailbox-title">{row.title}</span>
                        <span class="mailbox-detail">{row.detail}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>

      <Show when={menu()}>
        {(current) => (
          <div
            class="mailbox-menu"
            role="menu"
            style={{ left: `${current().x}px`, top: `${current().y}px` }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onMove(current().row.id, "top");
                setMenu(null);
              }}
            >
              置顶
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onMove(current().row.id, "bottom");
                setMenu(null);
              }}
            >
              置底
            </button>
            <Show when={current().box === "done"}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onRevert(current().row.id);
                  setMenu(null);
                }}
              >
                回溯到未读
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
