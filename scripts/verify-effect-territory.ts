#!/usr/bin/env bun
/**
 * Effect 的领地边界（docs/EFFECT.md 的机器形态）。
 *
 * Effect 进入的是 shell 会话层；它不进排版热路径、不进构建脚本、不进组件。
 * 这条边界成不成立，与 typeset-purity 同理，完全取决于没人「顺手 import
 * 一下」——注释挡不住 import，这道门禁挡得住。
 *
 * 三条规则：
 *   一、禁区（typeset/editor/scripts/e2e/ui）不出现 effect import；
 *       ui 的唯一例外是 Solid 适配器，它是全仓唯一同时 import solid-js
 *       与 effect 的文件。
 *   二、运行时只在边缘启动：Effect.runPromise / runSync / runFork 只准
 *       出现在 main.tsx 与适配器；组件与会话层内部只组合、不执行。
 *   三、版本钉死：任何 package.json 声明 effect 都必须是精确版本，
 *       升级是一次显式提交，不是 ^ 范围里的一次静默安装。
 *
 * 注入证明（各自变红，见 done-when）：在 packages/typeset/src/spacing.ts
 * 写 `import { Effect } from "effect"`；在 apps/desktop/src/ui/StatusLine.tsx
 * 写同一句；把根 package.json 的 effect 版本改成 `^4.0.0`。
 */

import { readFileSync } from "node:fs";
import { collect } from "./gate-lib.ts";

/** effect 主包与子路径（effect/testing 等）。不误伤 @effect-ui 之类的名字。 */
const EFFECT_IMPORT = /from\s+["'](?:effect)(?:\/[^"']*)?["']/;
const RUN_AT_EDGE = /\bEffect\.(?:runPromise|runSync|runFork|runPromiseExit|runSyncExit)\b/;

/** ui 里唯一可以碰 effect 的文件：SubscriptionRef → Solid signal 的适配器。 */
const ADAPTER = "apps/desktop/src/ui/effect-solid.ts";
/** 运行时的启动点：应用入口与适配器，再无第三处。 */
const RUN_EDGES = new Set(["apps/desktop/src/main.tsx", ADAPTER]);

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
    "packages/typeset/src/**/*.ts",
    "packages/editor/src/**/*.ts",
    "scripts/**/*.ts",
    "e2e/**/*.ts",
    "apps/desktop/e2e/**/*.ts",
    "apps/desktop/src/ui/**/*.{ts,tsx}",
  ],
  (file, line) =>
    file !== ADAPTER && EFFECT_IMPORT.test(line)
      ? "effect 进入了禁区（领地表见 docs/EFFECT.md）"
      : null,
);

// 二、运行时只在边缘启动。组合与执行分开，组件才能保持只读视图。
scan(["apps/desktop/src/**/*.{ts,tsx}"], (file, line) =>
  !RUN_EDGES.has(file) && RUN_AT_EDGE.test(line)
    ? "Effect 运行时在边缘之外启动（只准 main.tsx 与适配器执行）"
    : null,
);

// 三、版本钉死。范围符号让「今天的绿」证明不了「明天的绿」。
for (const manifestPath of collect(["package.json", "apps/desktop/package.json"])) {
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
