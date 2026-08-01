#!/usr/bin/env bun
import { readFileSync } from "node:fs";
/** Enforce one scoped canonical term per concept. */

import { Glob } from "bun";

interface Rule {
  /** Concept shown in failures. */
  readonly concept: string;
  /** Permitted term. */
  readonly canonical: string;
  /** Forbidden synonyms in prose and identifiers. */
  readonly synonyms: readonly string[];
  /** Synonyms forbidden only in type positions. */
  readonly typeNameOnly?: readonly string[];
  /** Repository path prefixes that own this concept. */
  readonly scope: readonly string[];
  /** Allowed names for distinct concepts in the same scope. */
  readonly except?: readonly string[];
  /** Reason for an exception. */
  readonly note?: string;
}

const RULES: readonly Rule[] = [
  {
    concept: "文档里一段可检索文本",
    canonical: "SearchableBlock / IndexedBlock / DisclosedBlock（同词根 Block，前缀说明形态）",
    synonyms: ["Fragment", "Passage", "Snippet", "Chunk", "Segment"],
    scope: [
      "crates/refrain-core/src/searchable_block.rs",
      "crates/refrain-core/src/material_listing.rs",
      "crates/refrain-store/src/project/",
    ],
  },
  {
    concept: "Run 之间的关系",
    canonical: "RunEdge（未绑定 id）/ ResolvedEdge（已绑定）",
    synonyms: ["Link", "Dependency"],
    typeNameOnly: ["Relation"],
    scope: ["crates/refrain-host/src/run_edge.rs", "crates/refrain-host/src/host.rs"],
  },
  {
    concept: "作者对一份材料的开放范围",
    canonical: "Disclosure",
    synonyms: ["Visibility", "Permission", "AccessLevel"],
    scope: ["crates/refrain-core/src/material_listing.rs"],
  },
  {
    // 面向公众的散文与产品术语漂开过一次：`4222cc5` 把「工单」改称「托付」、
    // `4a6b702` 又定为「发送」，而 README.zh-CN.md 三处「工单」一直留到 v0.2.3
    // ——**因为这道门禁的作用域只有源码**。Plan 1.2 的判据写的是「全仓 grep
    // 工单零命中」，而当时全仓里没有任何东西在读那条判据。
    //
    // 读者拿到的第一份文档用的是产品里已经不存在的词，比源码里的同义词更贵：
    // 源码的读者会去看定义，README 的读者没有第二处可对照。
    concept: "把一批提案交给智能体这件事",
    canonical: "发送 / 发送台 / 发送信箱（UI 与散文同一个词）",
    synonyms: ["工单", "托付", "委派"],
    scope: ["README.md", "README.zh-CN.md", "docs/"],
  },
];

const files: string[] = [];
// Include both implementation languages before applying concept scopes.
for await (const file of new Glob("{crates,apps,packages}/**/*.{rs,ts,tsx}").scan({ cwd: "." })) {
  const normalised = file.split(/[/\\]/).join("/");
  if (normalised.includes("node_modules/") || normalised.includes("/target/")) continue;
  files.push(normalised);
}
// Public prose is in scope too. A term the product renamed must not survive in
// the first document a reader opens — that regression already happened once and
// no gate could see it, because this list had source files only.
//
// Two scans, not one brace pattern: `{README.md,docs/**/*.md}` matches nothing
// under Bun's Glob (a `**` alternative inside braces silently yields an empty
// set). The rule's own scope check caught that — an empty scope reads as
// "the files this rule covers are no longer checked", which is exactly right.
for await (const file of new Glob("README*.md").scan({ cwd: "." })) {
  files.push(file.split(/[/\\]/).join("/"));
}
for await (const file of new Glob("docs/**/*.md").scan({ cwd: "." })) {
  files.push(file.split(/[/\\]/).join("/"));
}

const failures: string[] = [];
let checked = 0;

for (const rule of RULES) {
  // Require every scope prefix to match independently.
  for (const prefix of rule.scope) {
    if (!files.some((file) => file.startsWith(prefix))) {
      failures.push(
        `规则「${rule.concept}」的作用域 ${prefix} 没有匹配到任何文件：` +
          `它覆盖的代码已经不再被检查`,
      );
    }
  }
  const inScope = files.filter((file) => rule.scope.some((prefix) => file.startsWith(prefix)));
  for (const file of inScope) {
    checked += 1;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const synonym of rule.synonyms) {
      const first = synonym.charAt(0);
      if (first === "") {
        failures.push(`规则「${rule.concept}」包含空同义词`);
        continue;
      }
      // `\b` is defined on ASCII word characters, so it never matches beside a
      // CJK ideograph: `\b工单` finds nothing in `派出工单。` and the rule silently
      // passes. Both injections stayed green until this branch existed — an
      // assertion that cannot fail is not weaker than a missing one, it is worse,
      // because it reports coverage it does not have.
      //
      // CJK terms are matched as plain substrings (there are no word boundaries
      // to respect); Latin terms keep the boundary + either-initial-case rule.
      const isCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(first);
      const pattern = isCjk
        ? new RegExp(synonym)
        : new RegExp(`\\b[${first.toUpperCase()}${first.toLowerCase()}]${synonym.slice(1)}`);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (rule.except?.some((allowed) => line.includes(allowed))) return;
        failures.push(
          `${file}:${index + 1}  「${rule.concept}」只用 ${rule.canonical}，` +
            `这里出现了同义词 ${synonym}\n      ${line.trim()}`,
        );
      });
    }
    // Restrict ambiguous words to type positions.
    for (const synonym of rule.typeNameOnly ?? []) {
      const naming = new RegExp(
        `(?:struct|enum|type|trait)\\s+\\w*${synonym}\\b` +
          `|:\\s*\\w*${synonym}\\b` +
          `|->\\s*\\w*${synonym}\\b`,
      );
      lines.forEach((line, index) => {
        if (!naming.test(line)) return;
        if (rule.except?.some((allowed) => line.includes(allowed))) return;
        failures.push(
          `${file}:${index + 1}  「${rule.concept}」只用 ${rule.canonical}，` +
            `这里用 ${synonym} 命名了一个类型\n      ${line.trim()}`,
        );
      });
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:one-word-per-concept: SPEC §2「一个概念一个词」被违反");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:one-word-per-concept  (${RULES.length} 条规则，${checked} 个在作用域内的文件)`,
);
