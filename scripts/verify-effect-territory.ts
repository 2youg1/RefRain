#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Effect 的领地边界（docs/EFFECT.md 的机器形态）。
 *
 * Effect 进入的是 shell 会话层；它不进排版热路径、不进构建脚本、不进组件。
 * 这条边界成不成立，完全取决于没人「顺手 import 一下」——注释挡不住 import，
 * 这道门禁挡得住。排版热路径那一条也归它管：`docs/EFFECT.md` 一度把那条规则
 * 写成一道叫 `verify:typeset-purity` 的门禁，而那道门禁从来没有存在过。
 *
 * 三条规则：
 *   一、禁区（typeset/editor/scripts/e2e/ui）不出现 effect import；
 *       将来会话层回来时，它的视图适配器是唯一例外——全仓唯一同时 import
 *       视图库与 effect 的那个文件。步骤 10 之后没有这样的文件。
 *   二、运行时只在边缘启动：Effect.runPromise / runSync / runFork 只准
 *       出现在 main.tsx 与适配器；组件与会话层内部只组合、不执行。
 *   三、版本钉死：任何 package.json 声明 effect 都必须是精确版本，
 *       升级是一次显式提交，不是 ^ 范围里的一次静默安装。
 *
 * 注入证明（各自变红）：在 scripts/ 或 apps/native/src/ 的任一文件写
 * `import { Effect } from "effect"`；在同处写 `Effect.runPromise`；
 * 把根 package.json 的 effect 版本改成 `^4.0.0`。
 */

import { readFileSync } from "node:fs";
import { collect } from "./gate-lib.ts";

/** effect 主包与子路径（effect/testing 等）。不误伤 @effect-ui 之类的名字。 */
const EFFECT_IMPORT = /from\s+["'](?:effect)(?:\/[^"']*)?["']/;
const RUN_AT_EDGE = /\bEffect\.(?:runPromise|runSync|runFork|runPromiseExit|runSyncExit)\b/;

/**
 * 步骤 10 之后，Effect 在这个仓库里没有消费者：会话层随 Solid 表面一起删了，
 * 而 Native 的 TypeScript core 是同步 `update`（`native check --strict` 的受限
 * 子集），运行时进不去。所以这道门禁现在守的是**禁区仍然是禁区**，
 * 而不是「某个适配器是唯一例外」。
 *
 * 空集自检因此比以前更重要：它保证这几条 glob 里始终有文件被真扫到。
 * 将来 TypeScript 会话层重新出现时，把它的目录从禁区里移出去，
 * 并在这里恢复一个具名的运行时边缘——**不要**通过放宽空集自检来消红。
 */
const RUN_EDGES = new Set<string>();

const failures: string[] = [];
let scanned = 0;

const scan = (
  globs: readonly string[],
  judge: (file: string, line: string) => string | null,
): void => {
  const files = collect([...globs]);
  if (files.length === 0) {
    failures.push(`${globs.join(", ")} 一个文件也没扫到：这道门禁在检查一个空集`);
    return;
  }
  for (const file of files) {
    scanned += 1;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const why = judge(file, line);
        if (why !== null) failures.push(`${file}:${index + 1} ${why}：${line.trim().slice(0, 70)}`);
      });
  }
};

// 一、禁区不 import effect。
scan(
  [
    // ScriptC 静态层：Effect 会把它们降级到动态档，理由与步骤 10 之前相同。
    "scripts/**/*.ts",
    "e2e/**/*.ts",
    // Native 的 core 与协议：受限子集，运行时进不去。
    "apps/native/src/**/*.ts",
  ],
  (_file, line) =>
    EFFECT_IMPORT.test(line) ? "effect 进入了禁区（领地表见 docs/EFFECT.md）" : null,
);

// 二、运行时只在边缘启动。边缘集合现在是空的（见上），所以这条等价于
// 「全仓不得启动 Effect 运行时」——一旦会话层回来，把它的入口加进 RUN_EDGES。
scan(["apps/native/src/**/*.ts", "scripts/**/*.ts"], (file, line) =>
  !RUN_EDGES.has(file) && RUN_AT_EDGE.test(line)
    ? "Effect 运行时在边缘之外启动（当前没有声明任何边缘）"
    : null,
);

// 三、版本钉死。范围符号让「今天的绿」证明不了「明天的绿」。
for (const manifestPath of collect(["package.json", "apps/native/package.json"])) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  for (const group of [manifest.dependencies, manifest.devDependencies]) {
    const range = group?.effect;
    if (range !== undefined && !/^\d/.test(range)) {
      failures.push(`${manifestPath}: effect 版本必须精确（现在是 ${range}）`);
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:effect-territory");
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  `effect territory ok — ${scanned} 个文件；禁区零 effect import，运行时只在边缘，版本精确`,
);
