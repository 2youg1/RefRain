// 发送信箱在外壳里的那一节：信箱的生命周期（刷新时机、广播订阅）完整归这里，
// Workbench 只把它嵌进侧栏，不再知道信箱怎么呼吸。
//
// 管理页不在这里开：它是舞台行里的一层（MailboxSurface），由外壳挂——这里只把
// 「全部 →」那一击译成 onOpenMailbox。管理页读的仍是这个 TicketMailbox 实例，
// 与侧栏那格是同一份事实的两种读法（缩略与全量），所以不能各自持有一份状态。
import { createEffect, createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import type { RunWatch } from "../shell/run-watch";
import { type Box, browserMailboxGateway, TicketMailbox } from "../shell/ticket-mailbox";
import { TicketMailboxPanel } from "./TicketMailboxPanel";

export function MailboxSection(props: {
  rootId: string | null;
  path: string | null;
  runWatch: RunWatch;
  onOpenTicket: (box: Box) => void;
  onNotice: (text: string) => void;
  /** 「全部 →」那一击：管理页是一层 reference，开合归外壳。 */
  onOpenMailbox: () => void;
  /** 信箱本体：饭盒的提案与裁决也走它。 */
  onReady: (mailbox: TicketMailbox) => void;
  /** 格标题右侧显示的快捷键，由外壳的键位表提供。 */
  shortcutOf?: (box: Box) => string | null;
}): JSX.Element {
  const mailbox = new TicketMailbox(browserMailboxGateway);
  props.onReady(mailbox);
  const [tick, setTick] = createSignal(0);
  const view = createMemo(() => {
    tick();
    return mailbox.view();
  });

  const refresh = (): void => {
    if (props.rootId !== null && props.path !== null) {
      void mailbox.refresh(props.rootId, props.path);
    }
  };
  const stops = [
    mailbox.onChanged(() => setTick((value) => value + 1)),
    props.runWatch.onChanged(refresh),
  ];
  // 换文档、换项目：信箱的世界跟着换。
  createEffect(refresh);
  onCleanup(() => {
    for (const stop of stops) stop();
  });

  const revert = (id: string): void => {
    void mailbox.revert(id).then((text) => {
      if (text !== null) props.onNotice(text);
    });
  };

  return (
    <TicketMailboxPanel
      view={view()}
      onOpen={(_row, box) => props.onOpenTicket(box)}
      onMove={(id, edge) => void mailbox.moveWithinBox(id, edge)}
      onRevert={revert}
      onPin={(ids, pinned) => void mailbox.pinMany(ids, pinned)}
      onDiscard={(ids) => void mailbox.discard(ids)}
      onManage={() => props.onOpenMailbox()}
      {...(props.shortcutOf === undefined ? {} : { shortcutOf: props.shortcutOf })}
    />
  );
}
