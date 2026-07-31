#!/usr/bin/env bun
import { readFileSync } from "node:fs";
/**
 * 「读一次纯为订阅」那行不能被当成死代码删掉。
 *
 * 工作台里有五个 framework-free 的会话对象（ProjectSession / DocumentSession /
 * PanelStack / EditIntents / KARA）。它们不是 Solid 的信号——这是有意的，
 * 领域逻辑不该认识渲染框架。代价是它们的变化要靠一个 tick 信号转达：
 *
 *     const [panelTick, setPanelTick] = createSignal(0);
 *     const panels = new PanelStack(() => setPanelTick(v => v + 1));
 *     const reference = createMemo(() => {
 *       panelTick();                      // ← 这一行
 *       return panels.top?.content ?? null;
 *     });
 *
 * 那一行读一个从不使用的值。它**看着就是死代码**，而删掉它的后果是：
 * 类型检查通过、365 项单元测试全绿、面板从此静默停止刷新——作者点了没反应，
 * 没有任何东西会变红。这是实测出来的，不是推想。
 *
 * 抽象不是这里的答案。`fromSource(source, read)` 写过两遍撤过两遍：五处形态
 * 各异（`projectSession` 的回调兼做公告，KARA 的取消在 onCleanup 手动调），
 * 抽象会掩盖差异而不是隐藏复杂性。所以留下样板，但让它**被删就变红**。
 *
 * 判据是配对：每个 `xTick` 信号必须至少被读一次，且每个读到会话字段的 memo
 * 里都要有对应的 tick 读取。前者防止信号变成孤儿，后者防止 memo 失去订阅。
 *
 * 三条注入各对一条分支：
 *   - 删掉某个 memo 里的 `xTick();` → 红（分支 1：memo 失去订阅）
 *   - 删掉某个 tick 信号的全部读取点 → 红（分支 2：信号成孤儿）
 *   - 把扫描面指向不存在的文件 → 红（分支 3：扫描为空）
 */

import { collect } from "./gate-lib.ts";

/** 持有 framework-free 会话对象的外壳文件。通配符跟随代码。 */
const SHELL_SOURCES = ["apps/desktop/src/shell/*.tsx", "apps/desktop/src/shell/*.ts"];

const failures: string[] = [];
const files = collect(SHELL_SOURCES);
if (files.length === 0) {
  console.error("FAIL  verify:reactive-subscription: 扫到 0 个外壳文件 — 扫描面指错了地方");
  process.exit(1);
}

let tickSignals = 0;
let subscribingMemos = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");

  // —— 分支 2：每个 tick 信号都必须有人读 ——
  // 声明形如 `const [panelTick, setPanelTick] = createSignal(0);`
  for (const match of text.matchAll(/const\s*\[\s*(\w*[Tt]ick)\s*,\s*(set\w+)\s*\]\s*=/g)) {
    const [, getter] = match;
    if (getter === undefined) continue;
    tickSignals += 1;
    // 读取形如 `panelTick();`——排除声明行本身与 setter。
    const reads = [...text.matchAll(new RegExp(`(?<![.\\w])${getter}\\(\\)`, "g"))].length;
    if (reads === 0) {
      failures.push(
        `${file}: 信号 ${getter} 没有任何读取点 — 会话的变化到不了界面，而删掉它不会有任何测试变红`,
      );
    }
  }

  // —— 分支 1：订阅式 memo 的第一条语句必须是 tick 读取 ——
  // 形如：createMemo(() => {\n  xTick();\n  return session.field;\n});
  // 只检查「函数体第一行不是 return」的 memo：那正是为订阅而存在的形状。
  for (const match of text.matchAll(/createMemo(?:<[^>]*>)?\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/g)) {
    const body = match[1];
    if (body === undefined) continue;
    const statements = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));
    const first = statements[0];
    if (first === undefined) continue;
    // 一个 memo 只有 return 一句，说明它读的是别的 memo（已经是响应式的），
    // 不需要 tick。有 tick 的那种才是这道门禁的对象。
    if (/^\w*[Tt]ick\(\);$/.test(first)) {
      subscribingMemos += 1;
    }
  }
}

// —— 分支 1 的另一半：数目本身是不变量 ——
// 光看「每个信号有人读」不够：一个信号被两个 memo 读，删掉其中一个仍然过关。
// 所以把配对数登记下来，少一个就报，多一个也要求更新登记——与棘轮同一个道理。
// 9：新增 `selectedAnnotations`（作者勾了哪些批注要派发）。
// 已确认它确实需要 tick——`AnnotationSelection` 是 framework-free 的会话对象，
// 与另外五个同形，不是把一个已经响应式的值多包一层。
const EXPECTED_SUBSCRIBING_MEMOS = 9;
if (subscribingMemos !== EXPECTED_SUBSCRIBING_MEMOS) {
  failures.push(
    subscribingMemos < EXPECTED_SUBSCRIBING_MEMOS
      ? `订阅式 memo 从 ${EXPECTED_SUBSCRIBING_MEMOS} 减到 ${subscribingMemos} — 若确为有意收敛，请把 EXPECTED_SUBSCRIBING_MEMOS 下调；否则是某处的 tick 读取被当死代码删了`
      : `订阅式 memo 从 ${EXPECTED_SUBSCRIBING_MEMOS} 增到 ${subscribingMemos} — 请把 EXPECTED_SUBSCRIBING_MEMOS 上调并确认新增那处确实需要 tick`,
  );
}

if (failures.length > 0) {
  console.error("FAIL  verify:reactive-subscription");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:reactive-subscription  (${files.length} shell files; ${tickSignals} tick signals, ${subscribingMemos} subscribing memos)`,
);
process.exit(0);
