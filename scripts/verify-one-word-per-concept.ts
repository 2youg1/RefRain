#!/usr/bin/env bun
/**
 * 一个概念一个词。
 *
 * SPEC §2「领域语言」写着：「代码、测试、UI 文案使用同一套词。**一个概念一个词，
 * 禁止同义词。**」——但在这道门禁存在之前，没有任何东西执行它，于是同义词照样
 * 长出来：一次普查在 231 个公开类型里发现「文档里一段可检索文本」有四个名字
 * （`SearchableBlock` / `Fragment` / `Hit` / `Candidate`），而「检索命中」有两个
 * （`Hit` / `SearchHit`），其中前者的两个词还在同一个模块目录下。
 *
 * # 为什么不能只查字符串
 *
 * 同一个英文词在不同领域是**不同的概念**，删掉它反而是错的：
 *
 * - `ledger.rs` 的 `fragment` 是 SQL LIKE 的片段
 * - `pdf.rs` 的 `Fragment` 是 PDF 内容流里一段带坐标的文本
 * - `icons.rs` 的 `fragment` 是 URL 的 `#id`
 *
 * 所以每条规则都带**作用域**：只在拥有那个概念的模块里禁用它的同义词。一条不分
 * 作用域的规则要么放过真漂移，要么逼着正当代码改名。
 */

import { Glob } from "bun";

interface Rule {
  /** 这条规则守的概念，出现在失败信息里。 */
  readonly concept: string;
  /** 唯一许可的词。 */
  readonly canonical: string;
  /** 同义词，出现即失败。 */
  readonly synonyms: readonly string[];
  /** 只在这些路径下检查（前缀匹配）。 */
  readonly scope: readonly string[];
  /** 这些路径豁免：那里的同名词是别的概念。 */
  readonly except?: readonly string[];
  /** 为什么豁免，写给下一个读到失败信息的人。 */
  readonly note?: string;
}

const RULES: readonly Rule[] = [
  {
    concept: "文档里一段可检索文本",
    canonical: "SearchableBlock / IndexedBlock / DisclosedBlock（同词根 Block，前缀说明形态）",
    synonyms: ["Fragment", "Passage", "Snippet", "Chunk", "Segment"],
    scope: [
      "crates/refrain-core/src/searchable_block.rs",
      "crates/refrain-core/src/material_ref.rs",
      "crates/refrain-store/src/project/",
      "crates/refrain-app/src/material_access.rs",
    ],
  },
  {
    concept: "检索命中",
    canonical: "SearchHit（交出去的）/ ScoredHit（打分中间态，借用索引）",
    synonyms: ["Match", "Found", "Result"],
    scope: ["crates/refrain-store/src/files/search.rs"],
    except: ["PathMatch"],
    note: "PathMatch 是排序信号的名字，不是命中本身",
  },
  {
    concept: "Run 之间的关系",
    canonical: "RunEdge（未绑定 id）/ ResolvedEdge（已绑定）",
    synonyms: ["Link", "Dependency", "Relation"],
    scope: ["crates/refrain-host/src/run_edge.rs", "crates/refrain-host/src/host.rs"],
  },
  {
    concept: "作者对一份材料的开放范围",
    canonical: "Disclosure",
    synonyms: ["Visibility", "Permission", "AccessLevel"],
    scope: ["crates/refrain-core/src/material_ref.rs", "crates/refrain-app/src/material_access.rs"],
  },
];

const files: string[] = [];
for await (const file of new Glob("{crates,apps}/**/*.rs").scan({ cwd: "." })) {
  files.push(file.split(/[/\\]/).join("/"));
}

const failures: string[] = [];
let checked = 0;

for (const rule of RULES) {
  // 逐条作用域检查，而不是整条规则合并后再看。
  //
  // 起初这里只在「整条规则一个文件都没匹配到」时报错，于是一条带两个作用域
  // 路径的规则，改坏其中一个仍然全绿——另一个还匹配着。而失效的是那一个
  // 路径覆盖的全部文件，它们从此不再被检查，且没有任何东西会说。
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
    const text = await Bun.file(file).text();
    const lines = text.split("\n");
    for (const synonym of rule.synonyms) {
      const pattern = new RegExp(`\\b${synonym}\\b`);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (rule.except?.some((allowed) => line.includes(allowed))) return;
        failures.push(
          `${file}:${index + 1}  「${rule.concept}」只用 ${rule.canonical}，` +
            `这里出现了同义词 ${synonym}\n      ${line.trim()}`,
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
