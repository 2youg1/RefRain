// 托付信箱的树：待托付 / 已回复（徽标计数）/ 已裁决 三格，可折叠。
//
// 侧栏那一格是**缩略**：只挂前 MAILBOX_PEEK 条，其余折进管理页，格尾一行
// 「还有 N 封 →」是进入口。上界让侧栏有了高度上限，底部那组全局导航因此
// 永远留在屏内——满格滚动时它被挤出可视区，而那是作者去任何地方的路。
//
// 右键一单：置顶、置底、Pin、弃置、回溯（已裁决格）。Shift 连选、Ctrl 点选
// 之后，这些动作作用于整批。
import { createSignal, For, type JSX, Show } from "solid-js";
import type { Box, MailboxRow, MailboxView } from "../shell/ticket-mailbox";

export type MailboxBox = Box;

export type TicketMailboxPanelProps = {
  view: MailboxView;
  /** 点开一单：去它该在的地方（草稿→托付台，其余→逐句裁决）。 */
  onOpen: (row: MailboxRow, box: MailboxBox) => void;
  onMove: (id: string, edge: "top" | "bottom") => void;
  onRevert: (id: string) => void;
  onPin: (ids: readonly string[], pinned: boolean) => void;
  onDiscard: (ids: readonly string[]) => void;
  /** 进管理页：格尾「还有 N 封 →」与超出上界时的唯一去处。 */
  onManage: (box: MailboxBox) => void;
  /** 快捷键提示挂在格标题右侧：能用快捷键更方便的就把它显示出来。 */
  shortcutOf?: (box: MailboxBox) => string | null;
};

const GROUPS: readonly { box: MailboxBox; label: string }[] = [
  { box: "draft", label: "待托付" },
  { box: "unread", label: "已回复" },
  { box: "done", label: "已裁决" },
];

export function TicketMailboxPanel(props: TicketMailboxPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<MailboxBox>>(new Set());
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  /** 连选的锚点：Shift 从这里量到当前行。 */
  const [anchor, setAnchor] = createSignal<{ box: MailboxBox; id: string } | null>(null);
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

  const peekOf = (box: MailboxBox): readonly MailboxRow[] => props.view[box].peek;
  const countOf = (box: MailboxBox): number => props.view[box].all.length;
  const hiddenOf = (box: MailboxBox): number => props.view[box].hidden;

  /** 一次动作作用于谁：选中的那批，或者右键点到的这一单。 */
  const targets = (row: MailboxRow): readonly string[] => {
    const chosen = selected();
    return chosen.has(row.id) ? [...chosen] : [row.id];
  };

  const clickRow = (event: MouseEvent, row: MailboxRow, box: MailboxBox): void => {
    if (event.shiftKey) {
      const start = anchor();
      const rows = peekOf(box);
      const from = start === null ? -1 : rows.findIndex((entry) => entry.id === start.id);
      const to = rows.findIndex((entry) => entry.id === row.id);
      if (start !== null && start.box === box && from >= 0 && to >= 0) {
        const [low, high] = from <= to ? [from, to] : [to, from];
        setSelected(new Set(rows.slice(low, high + 1).map((entry) => entry.id)));
        return;
      }
      setSelected(new Set([row.id]));
      setAnchor({ box, id: row.id });
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      setAnchor({ box, id: row.id });
      return;
    }
    setSelected(new Set<string>());
    setAnchor({ box, id: row.id });
    props.onOpen(row, box);
  };

  return (
    <div class="mailbox" onPointerLeave={() => setMenu(null)}>
      <div class="rail-group">
        托付信箱
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
              <Show when={props.shortcutOf?.(group.box)}>
                {(keys) => <span class="mailbox-shortcut">{keys()}</span>}
              </Show>
              <span class="mailbox-count">{countOf(group.box)}</span>
            </button>
            <Show when={!collapsed().has(group.box)}>
              <ul>
                <For each={peekOf(group.box)}>
                  {(row) => (
                    <li>
                      <button
                        type="button"
                        class="mailbox-row"
                        classList={{
                          "is-selected": selected().has(row.id),
                          "is-pinned": row.pinned,
                        }}
                        onClick={(event) => clickRow(event, row, group.box)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setMenu({ row, box: group.box, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <Show when={row.pinned}>
                          <span class="mailbox-pin" aria-label="已固定">
                            ◆
                          </span>
                        </Show>
                        <span class="mailbox-title">{row.title}</span>
                        <span class="mailbox-detail">{row.detail}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              {/* 折起来的那些不在侧栏里排队，它们在管理页。 */}
              <Show when={hiddenOf(group.box) > 0}>
                <button
                  type="button"
                  class="mailbox-more"
                  onClick={() => props.onManage(group.box)}
                >
                  还有 {hiddenOf(group.box)} 封 →
                </button>
              </Show>
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
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onPin(targets(current().row), !current().row.pinned);
                setMenu(null);
              }}
            >
              {current().row.pinned ? "取消固定" : "固定"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onDiscard(targets(current().row));
                setSelected(new Set<string>());
                setMenu(null);
              }}
            >
              弃置
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
                回溯到已回复
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
