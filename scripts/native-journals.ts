// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 一条主机答复在字节流里的开头，同 `protocol_magic`。 */
const RESPONSE_MAGIC = Buffer.from("RFRN", "ascii");

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
 * 带理由的枚举而不是布尔：`no-verify` 必须写出挡路的那件事。今天八条全是
 * `verify`——M8 是唯一挡过路的那件事，单元 13 之后它不再挡。挡住时改这张表
 * 即改档，而不是去八个地方找 `--no-verify`。
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
 * 这条录制里的主机答复声明的协议版本。
 *
 * **为什么要问**：回放把录制的字节当作世界喂给核心，而核心的
 * `isDispatchResponse` 拿编译进去的 `PROTOCOL_VERSION` 逐字比。两者不等时
 * 每一条答复都被当成坏契约，而指纹检查点依旧对得上——车道因此会在
 * 根本没在判产品的情况下报绿。实测：协议 4 →5 那一步上，八条全绿。
 *
 * 字段位置不在这里第二次定义：魔数与头部布局都是生成的（`RFRN`，
 * 版本在 [4..6]），与 `generated/protocol.ts` 同源。
 */
export function recordedProtocolVersions(name: JournalName): readonly number[] {
  const bytes = readFileSync(journalPath(name));
  const versions = new Set<number>();
  for (
    let at = bytes.indexOf(RESPONSE_MAGIC);
    at >= 0;
    at = bytes.indexOf(RESPONSE_MAGIC, at + 4)
  ) {
    if (at + 6 > bytes.length) break;
    versions.add(bytes.readUInt16LE(at + 4));
  }
  return [...versions].sort((left, right) => left - right);
}

/**
 * 录制用的临时项目：两份中文正文。写死是刻意的——断言要有确定的文本可对，
 * 中文正文同时压住 UTF-8 的路径与可访问名。
 */
export const fixtureDocuments: Readonly<Record<string, string>> = {
  "章一.md": "# 第一章\n\n剑一直握在他手里。\n",
  "章二.md": "# 第二章\n\n雨停在门外。\n",
};

// M8 曾经挡住五条 journal 的指纹核对：正稿投影住在 `host_bridge` 的模块缓冲里，
// 而回放不调主机，于是录制时界面有正文、回放时是空白。单元 13 把投影的落地从
// 请求回调移到核心的 `host_result` 臂——回放走的正是那条路——之后八条全部逐帧
// 对得上（28 个检查点变 81 个）。这条注释留着，是因为「为什么当初不能验」比
// 「现在能验了」更容易再次丢失。

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
 * 分档的实测边界（2026-08-15，本机）：单元 13 之前，录一条「认领项目、点开
 * 稿子」的会话再 `--verify` 回放，前三个 checkpoint 逐帧对得上，第四帧——点开
 * 文档行之后的那一帧——开始不匹配，因为回放拿不到正稿文本（M8）。投影的落地
 * 移进核心的 `host_result` 臂之后，八条全部逐帧对得上。
 */
export const journalPlans: Readonly<Record<JournalName, JournalPlan>> = {
  // 稿子：认领、点开、写一句、保存、撤销。整套产品最短的一条真路径。
  manuscript: {
    destination: 0,
    tier: { mode: "verify" },
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
    tier: { mode: "verify" },
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
    tier: { mode: "verify" },
    steps: [
      ...openFirstDocument,
      { kind: "shortcut", id: "go.4" },
      { kind: "expect", pattern: 'name="写给 agent 的要求"' },
      { kind: "expect", pattern: "Run 名录" },
    ],
  },

  mailbox: {
    destination: 4,
    tier: { mode: "verify" },
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
    tier: { mode: "verify" },
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
      // 换主题的证据是**当前主题名成了下一套**，而不是「按钮还在」。
      //
      // 不用 `absent`：它只读一次屏，而换主题要过一趟 Rust（界面立刻换肤，名字显示的
      // 是落盘那一份）。一条不轮询的断言在这里测的是答复快不快，不是主题换没换
      // ——踩过的坑 #6。`expect` 轮询，且 kasumi 是一个比「tou 没了」强得多的事实。
      { kind: "expect", pattern: 'name="kasumi"' },
    ],
  },
};

/** 表里的名字，声明序。 */
export const journalNames = Object.keys(journalPlans) as readonly JournalName[];
