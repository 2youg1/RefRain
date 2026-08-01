// 工单信箱在外壳里的那一节：信箱的生命周期（刷新时机、广播订阅）完整归这里，
// Workbench 只把它嵌进侧栏，不再知道信箱怎么呼吸。
import { createEffect, createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import type { RunWatch } from "../shell/run-watch";
import { browserMailboxGateway, TicketMailbox } from "../shell/ticket-mailbox";
import { TicketMailboxPanel } from "./TicketMailboxPanel";

export function MailboxSection(props: {
  rootId: string | null;
  path: string | null;
  runWatch: RunWatch;
  onOpenTicket: (box: "draft" | "unread" | "done") => void;
  onNotice: (text: string) => void;
  /** 信箱本体：饭盒的提案与裁决也走它。 */
  onReady: (mailbox: TicketMailbox) => void;
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

  return (
    <TicketMailboxPanel
      view={view()}
      onOpen={(_row, box) => props.onOpenTicket(box)}
      onMove={(id, edge) => mailbox.moveWithinBox(id, edge)}
      onRevert={(id) =>
        void mailbox.revert(id).then((text) => {
          if (text !== null) props.onNotice(text);
        })
      }
    />
  );
}
