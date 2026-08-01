#!/usr/bin/env bun
/**
 * 门禁：信箱注入 2000 单后，侧栏挂载的行数不随总数增长。
 *
 * ## 这道门禁挡的是一次实测到的灾难
 *
 * v0.2.2 实测（1440×900，往 `.mailbox-group ul` 注入行）：
 *
 * | 行数 | 侧栏 scrollHeight | 底部导航 top | 可见 | DOM 节点 |
 * |---:|---:|---:|:-:|---:|
 * | 20 | 1320 | 1081 | **否** | 164 |
 * | 200 | 7440 | 7201 | **否** | 884 |
 *
 * **二十单就把全局导航挤出可视区**。文档书架有窗口化，信箱一行都没有，
 * 两百单就是两百个 DOM 节点。
 *
 * 修法不是给侧栏做窗口化，而是照邮箱软件的形状：侧栏那一格是**缩略**，
 * 只显示前 `MAILBOX_PEEK` 条，其余折进管理页。侧栏因此**有上界**——
 * 三格 × 5 行，与总数无关。
 *
 * ## 为什么量数据层而不开浏览器
 *
 * 上界由 `group()` 的 `rows.slice(0, MAILBOX_PEEK)` 建立，而 `TicketMailboxPanel`
 * 只是 `<For each={peekOf(box)}>`——渲染多少行完全由 `peek` 的长度决定。
 * 量 `peek.length` 与量 DOM 节点数是同一个命题，而前者不需要浏览器、不会
 * 因为 CSS 改动而假红。
 *
 * **但这条推理有个前提**：面板确实读 `peek` 而不是 `all`。所以下面单独有一条
 * 断言去源码里核实那个绑定——推理链上最脆的一环要被钉住，否则将来有人把
 * `peekOf` 改成 `allOf`，数据层照样有上界而侧栏照样爆掉，这道门禁全绿。
 *
 * ## 注入验红（三处，实测）
 *
 * | 注入 | 结果 |
 * |---|---|
 * | `group()` 改成 `peek: rows` | 红：2000 单时 peek 长度 2000 |
 * | `MAILBOX_PEEK` 改成 500 | 红：上界超过一屏能放下的行数 |
 * | 面板改成 `<For each={allOf(...)}>` | 红：面板绕过了 peek |
 */

import { readFileSync } from "node:fs";

import { BOXES, MAILBOX_PEEK, TicketMailbox } from "../apps/desktop/src/shell/ticket-mailbox.ts";

/**
 * 造一批假单，喂给**产品自己的** `TicketMailbox`。
 *
 * 关键是走 `refresh()` 而不是自己 `slice`。第一版这里是
 * `const peek = list.slice(0, MAILBOX_PEEK)`——那是把 `group()` 的实现抄了一遍，
 * 于是注入「`group()` 改成 `peek: rows`」时门禁**照常全绿**：断言钉住的是我
 * 自己那份副本，与产品走的那条路径无关。
 *
 * 这是「断言必须落在真正投递的那一档」的一个实例。切片规则只有一个权威，
 * 门禁要问的是那个权威，不是一份长得一样的复制品。
 */
async function mailboxWith(total: number): Promise<TicketMailbox> {
  const mailbox = new TicketMailbox({
    hostState: async () => ({
      tasks: Array.from({ length: total }, (_, index) => ({
        id: `t${index}`,
        prompt: `第 ${index} 单`,
        document: null,
        progress: "draft" as const,
      })),
    }),
    reviewState: async () => ({
      proposals: Array.from({ length: total }, (_, index) => ({
        id: `p${index}`,
        before: `提案 ${index} 的原文`,
        baseline: `b${index}`,
      })),
      verdicts: [],
      batch: [],
    }),
    standings: async () => [],
    setStanding: async () => undefined,
  } as unknown as ConstructorParameters<typeof TicketMailbox>[0]);
  await mailbox.refresh("root", "doc.md");
  return mailbox;
}

const failures: string[] = [];

/**
 * 一屏能放下的行数上界。
 *
 * 三格各 `MAILBOX_PEEK` 行，加上格标题与格尾的「还有 N 封 →」。这个数存在的
 * 意义是：`MAILBOX_PEEK` 若被改成一个大数，缩略就不再是缩略，而前两条断言
 * （不随总数增长）**仍然成立**——上界与总数无关，但上界本身可以大到爆屏。
 */
const SCREEN_ROWS = 24;

// 一、上界与总数无关。逐级加压，peek 长度必须恒定。
// 量的是产品自己 `view()` 的输出，不是本文件重算的一份切片。
const observed = new Map<number, number>();
for (const total of [0, 3, 20, 200, 2000]) {
  const view = (await mailboxWith(total)).view();
  const group = view.draft;
  observed.set(total, group.peek.length);

  if (group.peek.length > MAILBOX_PEEK) {
    failures.push(`${total} 单时侧栏挂了 ${group.peek.length} 行，上界是 ${MAILBOX_PEEK}`);
  }
  if (group.peek.length + group.hidden !== total) {
    failures.push(
      `${total} 单：缩略 ${group.peek.length} + 折起 ${group.hidden} ≠ 总数 ${total}——有单丢了`,
    );
  }
  if (group.all.length !== total) {
    failures.push(`${total} 单：管理页拿到 ${group.all.length} 行，全量应当无损`);
  }
}

// 二、20 单与 2000 单必须挂同样多的行。这是「不随总数增长」的直接形式。
if (observed.get(20) !== observed.get(2000)) {
  failures.push(
    `20 单挂 ${observed.get(20)} 行而 2000 单挂 ${observed.get(2000)} 行——挂载量随总数增长`,
  );
}

// 三、三格合计仍在一屏之内。上界与总数无关，不代表上界本身够小。
const worstCase = BOXES.length * MAILBOX_PEEK;
if (worstCase > SCREEN_ROWS) {
  failures.push(
    `三格满载共 ${worstCase} 行，超过一屏能放下的 ${SCREEN_ROWS} 行——` +
      "底部导航会被挤出可视区，而那正是这道门禁要挡的原始灾难",
  );
}

// 四、面板确实读缩略。前三条全部建立在这个绑定之上。
const panel = readFileSync("apps/desktop/src/ui/TicketMailboxPanel.tsx", "utf8");
if (!panel.includes("<For each={peekOf(group.box)}>")) {
  failures.push(
    "TicketMailboxPanel 没有按 peekOf 渲染那一格。\n" +
      "      数据层的上界只有在面板读 peek 时才是侧栏的上界；改读 all 之后\n" +
      "      前三条断言照样全绿，而侧栏照样会被两千单撑爆。",
  );
}

// 五、管理页分页，不一次挂全量。侧栏折起来的单要有个去处，而那个去处
// 若一次渲染两千行，灾难只是从侧栏搬到了管理页。
//
// 页大小从源码里读，不 import：`.tsx` 一经 import 就要解析 JSX 运行时，
// 而这道门禁不需要渲染任何东西。读源码同样能拿到那个数，且拿不到时会
// 明确报「读不出」而不是静默用一个默认值。
const manager = readFileSync("apps/desktop/src/ui/MailboxManager.tsx", "utf8");
const pageSize = Number(manager.match(/MANAGER_PAGE_SIZE = (\d+)/)?.[1] ?? Number.NaN);
if (Number.isNaN(pageSize)) {
  failures.push("从 MailboxManager.tsx 读不出 MANAGER_PAGE_SIZE——管理页是否还有分页无从判断");
} else if (pageSize > 100) {
  failures.push(`管理页一页 ${pageSize} 行，过大`);
}
if (!manager.includes("MANAGER_PAGE_SIZE")) {
  failures.push("MailboxManager 没有按页切片，管理页会一次挂载全部单");
}

if (failures.length > 0) {
  console.error("FAIL  verify:mailbox-scale: 侧栏必须有上界，且上界要放得进一屏");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:mailbox-scale  (2000 单时侧栏仍挂 ${observed.get(2000)} 行/格，` +
    `三格共 ${worstCase} 行 ≤ 一屏 ${SCREEN_ROWS} 行，管理页每页 ${pageSize} 行)`,
);
