// 发送信箱的管理页：侧栏放不下的那些在这里，全套邮件管理动作也在这里。
//
// 侧栏那格只挂前几条（MAILBOX_PEEK）加未读徽标与「全部」入口，因为它同时还得
// 让底部那组全局导航留在屏内。作者要一次处理很多单时来这里：整格全量、分页
// 翻、多选批量、回收站取回。
//
// 列表状态与全部操作归 shell/ticket-mailbox.ts 的 TicketMailbox——与侧栏那格
// 是同一个实例（同一份事实的两种读法），这个组件只做投影：订阅、读 view()、
// 把点击译成调用。
import { createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import type { Box, TicketMailbox } from "../shell/ticket-mailbox";
import { MailboxManager, type ManagerBox } from "./MailboxManager";

export type MailboxSurfaceProps = {
  mailbox: TicketMailbox;
  /** 入口指定的落点；「全部」不给，落在最该处理的已回复。 */
  initialBox: ManagerBox | null;
  /** 点开一单：去它该在的地方（草稿→发送台，其余→逐句裁决）。 */
  onOpenTicket: (box: Box) => void;
  /** 撤回合并：外壳拿转移去喂编辑器（与回档同一个接缝），这里只报一句话。 */
  onCountermand: (ids: readonly string[]) => void;
  onNotice: (text: string) => void;
  onClose: () => void;
};

export function MailboxSurface(props: MailboxSurfaceProps): JSX.Element {
  const [box, setBox] = createSignal<ManagerBox>(props.initialBox ?? "unread");
  // 与 MailboxSection 同一形：信箱是 framework-free 的会话，变化靠 tick 转达。
  const [tick, setTick] = createSignal(0);
  onCleanup(props.mailbox.onChanged(() => setTick((value) => value + 1)));
  const view = createMemo(() => {
    tick();
    return props.mailbox.view();
  });

  const revert = (id: string): void => {
    void props.mailbox.revert(id).then((text) => {
      if (text !== null) props.onNotice(text);
    });
  };

  return (
    <aside class="mailbox-surface" data-quarter="reference" aria-label="发送信箱">
      <header>
        <div>
          <small>MAILBOX</small>
          <h2>发送信箱</h2>
        </div>
        <button type="button" onClick={() => props.onClose()}>
          返回正文
        </button>
      </header>
      <MailboxManager
        view={view()}
        box={box()}
        onBox={(next) => setBox(next)}
        onOpen={(_row, opened) => props.onOpenTicket(opened)}
        onMove={(id, edge) => void props.mailbox.moveWithinBox(id, edge)}
        onPin={(ids, pinned) => void props.mailbox.pinMany(ids, pinned)}
        onDiscard={(ids) => void props.mailbox.discard(ids)}
        onRestore={(ids) => void props.mailbox.restoreMany(ids)}
        onRevert={revert}
        onCountermand={props.onCountermand}
      />
    </aside>
  );
}
