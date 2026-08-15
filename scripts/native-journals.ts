/**
 * 八条 e2e journal 的唯一权威：叫什么、去哪个去处、怎么走、能不能逐帧对指纹。
 *
 * **接上哪个功能**：会话录制与回放（Native SDK 的 `NATIVE_SDK_SESSION_RECORD` /
 * `NATIVE_SDK_SESSION_REPLAY`）。`record-native-journals.ts` 按这张表在真窗上录，
 * `replay-native-journals.ts` 按同一张表在 CI 上回放——两侧只共享这张表，
 * 回放侧根本不认识 `JournalStep`。
 *
 * **在全局逻辑中负责什么**：一处回答「八去处各有哪一条 journal」。计划
 * （P1 · 安全网扩容）要求八个去处各至少一条；`Record<JournalName, JournalPlan>`
 * 让这条要求由类型系统执行——少一个成员是编译错，不是运行时少跑一条。
 * 去处下标与中文标签不在这里第二次定义：下标同 `apps/native/src/workbench.ts`，
 * 断言里的中文同 `apps/native/src/workbench_view.zig` 与 `app_main.zig` 的界面文案。
 *
 * **能复用什么**：`journalPlans` 的键就是 journal 文件名；`fixtureDocuments`
 * 是录制用的临时项目内容，断言直接引用其中的正文，所以两者不会各说各的。
 */

import { join } from "node:path";

/** 八条 journal 的名字，同 `workbench.ts` 的去处常量小写形。 */
export type JournalName =
  | "manuscript"
  | "files"
  | "review"
  | "dispatch"
  | "mailbox"
  | "connections"
  | "history"
  | "settings";

/**
 * 一步驱动。穷尽枚举而不是「可选字段的动作记录」：新增一种动作必须改
 * 所有读者，而不是让某个读者悄悄忽略它。
 *
 * `expect` 同时是同步手段与行为断言——录制不靠定长 sleep，靠等到界面
 * 真的说出那句话；等不到就红在这一步，而不是把一个空窗口录进 journal。
 */
export type JournalStep =
  | { readonly kind: "click"; readonly role: string; readonly name: string }
  | { readonly kind: "shortcut"; readonly id: string }
  | {
      readonly kind: "type";
      readonly role: string;
      readonly name: string;
      readonly text: string;
    }
  | { readonly kind: "expect"; readonly pattern: string }
  | { readonly kind: "absent"; readonly pattern: string };

/**
 * 这条 journal 能不能逐帧对指纹，不能的话被谁挡住。
 *
 * 带理由的枚举而不是布尔：`no-verify` 必须写出挡路的那件事（今天全是
 * M8——正稿住在 `host_bridge` 的模块变量里，回放把主机答复直接喂给 core，
 * 视图没有一条路拿到正稿文本）。M8 闭合时改这张表即改档，而不是去八个
 * 地方找 `--no-verify`。
 */
export type VerifyTier =
  | { readonly mode: "verify" }
  | { readonly mode: "no-verify"; readonly blockedBy: string };

export interface JournalPlan {
  /** `workbench.ts` 的去处下标：0 稿子、1 文件、2 裁决、3 派发、4 信箱、5 连接、6 历史、7 设置。 */
  readonly destination: number;
  readonly tier: VerifyTier;
  readonly steps: readonly JournalStep[];
}

/** journal 与录制驱动共处的目录。 */
export const journalDirectory = join(import.meta.dir, "../e2e/native");

/** 这条 journal 的文件路径。 */
export function journalPath(name: JournalName): string {
  return join(journalDirectory, `${name}.journal`);
}

/**
 * 录制用的临时项目：两份中文正文。写死是刻意的——断言要有确定的文本可对，
 * 中文正文同时压住 UTF-8 的路径与可访问名。
 */
export const fixtureDocuments: Readonly<Record<string, string>> = {
  "章一.md": "# 第一章\n\n剑一直握在他手里。\n",
  "章二.md": "# 第二章\n\n雨停在门外。\n",
};

/** M8 的原话，八条里用到的地方只写一次。 */
const manuscriptNodeBlocked =
  "M8: the manuscript projection lives in host_bridge's module buffer, so replay feeds the core but no path hands the view its text";

/** 作者每次都要走的头两步：认领项目文件夹，看见名录。 */
const adoptProject: readonly JournalStep[] = [
  { kind: "expect", pattern: 'role=button name="打开一个项目文件夹"' },
  { kind: "click", role: "button", name: "打开一个项目文件夹" },
  { kind: "expect", pattern: 'name="章一\\.md"' },
];

/** 认领之后点开第一份稿子——需要一份打开的稿子的去处都从这里出发。 */
const openFirstDocument: readonly JournalStep[] = [
  ...adoptProject,
  { kind: "click", role: "treeitem", name: "章一.md" },
  { kind: "expect", pattern: "剑一直握在他手里" },
];

/**
 * 八条 journal。`Record` 而不是数组：漏一个去处 `bun run check:ts` 就红。
 *
 * 分档的实测边界（2026-08-15，本机）：录一条「认领项目、点开稿子」的会话
 * 再 `--verify` 回放，前三个 checkpoint 逐帧对得上，第四帧——点开文档行之后
 * 的那一帧——开始不匹配。所以不开稿子的三条走 `--verify`，开了稿子的五条
 * 走 `--no-verify` 并点名 M8。
 */
export const journalPlans: Readonly<Record<JournalName, JournalPlan>> = {
  // 稿子：认领、点开、写一句、保存、撤销。整套产品最短的一条真路径。
  manuscript: {
    destination: 0,
    tier: { mode: "no-verify", blockedBy: manuscriptNodeBlocked },
    steps: [
      ...openFirstDocument,
      // 舞台规则：正文区没有工具栏按钮（壳上不许有 Go to / Theme / Undo / Save）。
      { kind: "absent", pattern: 'name="(Go to|Theme|Undo|Save)"' },
      {
        kind: "type",
        role: "textbox",
        name: "RefRain manuscript",
        text: "剑一直握在他手里。雨从檐上落下来。",
      },
      { kind: "expect", pattern: "雨从檐上落下来" },
      { kind: "expect", pattern: "有未保存改动" },
      { kind: "shortcut", id: "document.save" },
      { kind: "expect", pattern: "已保存" },
      { kind: "shortcut", id: "document.undo" },
      { kind: "expect", pattern: "剑一直握在他手里" },
    ],
  },

  // 文件：认领之后名录必须画出行来，而且总数与行数一致——这正是「文件树
  // 一直画零行」那条缺陷（D16）的现场，行数是答复里那个数组的长度。
  files: {
    destination: 1,
    tier: { mode: "verify" },
    steps: [
      ...adoptProject,
      { kind: "expect", pattern: 'name="章二\\.md"' },
      { kind: "expect", pattern: 'name="2 / 2"' },
    ],
  },

  // 裁决：栏上的行是唯一入口——裁决与派发没有固定键位（commands.zig）。
  review: {
    destination: 2,
    tier: { mode: "no-verify", blockedBy: manuscriptNodeBlocked },
    steps: [
      ...openFirstDocument,
      { kind: "click", role: "treeitem", name: "裁决" },
      { kind: "expect", pattern: "待裁决的提案" },
      { kind: "expect", pattern: "没有等待裁决的提案" },
    ],
  },

  // 派发：Ctrl+4 是 Agent 层，默认落在派发（workbench.ts 的 agentDestination）。
  dispatch: {
    destination: 3,
    tier: { mode: "no-verify", blockedBy: manuscriptNodeBlocked },
    steps: [
      ...openFirstDocument,
      { kind: "shortcut", id: "go.4" },
      { kind: "expect", pattern: 'name="写给 agent 的要求"' },
      { kind: "expect", pattern: "Run 名录" },
    ],
  },

  mailbox: {
    destination: 4,
    tier: { mode: "no-verify", blockedBy: manuscriptNodeBlocked },
    steps: [
      ...openFirstDocument,
      { kind: "shortcut", id: "go.5" },
      { kind: "expect", pattern: "信箱是空的" },
    ],
  },

  // 连接：不需要项目，也不需要稿子。探测本机装了什么会走一条真的主机效果，
  // 它的答复进 journal，回放时喂回——不依赖录制机今天装了哪些 harness。
  connections: {
    destination: 5,
    tier: { mode: "verify" },
    steps: [
      { kind: "shortcut", id: "go.6" },
      { kind: "expect", pattern: "本机 Harness" },
      { kind: "click", role: "button", name: "重新探测本机装了什么" },
      { kind: "expect", pattern: "本机 Harness" },
    ],
  },

  history: {
    destination: 6,
    tier: { mode: "no-verify", blockedBy: manuscriptNodeBlocked },
    steps: [
      ...openFirstDocument,
      { kind: "shortcut", id: "go.7" },
      { kind: "expect", pattern: "这份稿子改过什么" },
      { kind: "expect", pattern: "还没有可回档的改动" },
    ],
  },

  // 设置：唯一一条从头到尾没有项目的 journal——第一次打开软件的那个状态
  // 也必须能一直走到换主题。
  settings: {
    destination: 7,
    tier: { mode: "verify" },
    steps: [
      { kind: "shortcut", id: "go.1" },
      { kind: "expect", pattern: "专注写作（KARA）" },
      { kind: "expect", pattern: 'name="tou"' },
      { kind: "click", role: "button", name: "换下一套主题" },
      // 换主题的证据是当前主题名不再是 tou，而不是「按钮还在」。
      { kind: "absent", pattern: 'name="tou"' },
    ],
  },
};

/** 表里的名字，声明序。 */
export const journalNames = Object.keys(journalPlans) as readonly JournalName[];
