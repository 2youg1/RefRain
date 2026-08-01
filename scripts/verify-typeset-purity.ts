#!/usr/bin/env bun
/**
 * 排版引擎与编辑器内核的那条缝。
 *
 * 「服务端跑一切、客户端各做各的」能成立，靠的是这两个包不知道自己跑在
 * 哪里：没有依赖、没有 DOM、没有 `@tauri-apps`。今天这条缝是成立的——
 * 但它成不成立完全取决于没人「顺手 import 一下」，而注释挡不住任何一次
 * import。这道门禁让它明天也成立。
 *
 * 两个包一起守，因为它们是同一层的东西：`packages/editor` 已经零依赖
 * （实测 2,394 行、`package.json` 无 dependencies 字段），`packages/typeset`
 * 从第一天就该在同一条线上。
 *
 * 注入证明：在 `packages/typeset/src/spacing.ts` 里写一句
 * `document.createElement("span")`，这里退出 1 并指出文件与行号；
 * 给它的 `package.json` 加一个 dependencies 字段亦然。
 */

import { readFileSync } from "node:fs";
import { collect } from "./gate-lib.ts";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/**
 * 两个包，两种「纯」。混为一谈会得到一道谁也不服的门禁。
 *
 * - `packages/typeset` **零 DOM**：它算的是数值，服务端与客户端都要能跑。
 * - `packages/editor` 必须碰 DOM——它就是 contenteditable 的虚拟视图。它的
 *   纯指的是**零依赖、零宿主**：不 import 任何 npm 包、不 import
 *   `@tauri-apps`，所以它跑在哪个壳里都不知道。
 *
 * 第一版把两者写成同一条规则，`packages/editor` 当场报出三十处 `HTMLElement`
 * ——那不是违规，那是它的工作。
 */
const PACKAGES = [
  { path: "packages/typeset", forbidsDom: true },
  { path: "packages/editor", forbidsDom: false },
] as const;

/** 两个包都不准碰的东西：宿主、浏览器存储、网络。 */
const FORBIDDEN_EVERYWHERE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /@tauri-apps/, why: "宿主" },
  { pattern: /\blocalStorage\b/, why: "浏览器存储" },
  { pattern: /\bfetch\s*\(/, why: "网络" },
];

/** 只有排版引擎不准碰的东西：DOM。 */
const FORBIDDEN_IN_TYPESET: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bdocument\s*\./, why: "DOM" },
  { pattern: /\bwindow\s*\./, why: "DOM" },
  { pattern: /\bHTMLElement\b/, why: "DOM" },
];

const failures: string[] = [];

// 一、两个包都不准声明运行时依赖。
//
// devDependencies 不算：那是构建这个包的工具，不会跟着它跑到服务端去。
for (const { path: pkg } of PACKAGES) {
  const manifestPath = `${pkg}/package.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  for (const [group, entries] of [
    ["dependencies", manifest.dependencies],
    ["peerDependencies", manifest.peerDependencies],
    ["optionalDependencies", manifest.optionalDependencies],
  ] as const) {
    for (const name of Object.keys(entries ?? {})) {
      failures.push(`${manifestPath}: ${group} 里出现了 ${name}；这个包必须零依赖`);
    }
  }
}

// 二、源码里不准出现 DOM、宿主、存储、网络。
let scanned = 0;
for (const { path: pkg, forbidsDom } of PACKAGES) {
  const files = collect([`${pkg}/src/**/*.ts`]);
  if (files.length === 0) {
    failures.push(`${pkg}/src 一个文件也没扫到：这道门禁在检查一个空集`);
    continue;
  }
  const rules = forbidsDom
    ? [...FORBIDDEN_EVERYWHERE, ...FORBIDDEN_IN_TYPESET]
    : FORBIDDEN_EVERYWHERE;
  for (const file of files) {
    scanned += 1;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      // 注释里说「不准用 document」是文档，不是违规。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          failures.push(`${file}:${index + 1} 出现${rule.why}：${line.trim().slice(0, 70)}`);
        }
      }
    });
  }
}

// 三、每个包都要真的有源码。
//
// 一个空包与一个干净包，输出完全一样——而空包意味着这道门禁什么也没量。
if (scanned === 0) {
  failures.push("两个包一个源文件都没有：这道门禁没有量到任何东西");
}

if (failures.length > 0) {
  console.error("FAIL  verify:typeset-purity");
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  `typeset purity ok — ${PACKAGES.length} 个包、${scanned} 个源文件；` +
    `排版引擎零 DOM，两个包零依赖零宿主`,
);
