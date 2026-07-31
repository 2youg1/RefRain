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
  /**
   * 只在**类型名位置**才算漂移的同义词。
   *
   * 有些词同时是正当的动词或算法名：检索模块里 `Matching a query`、`the
   * subsequence matcher`、`characters that matched` 全都是在说「怎么匹配」，
   * 而不是在给「命中」起第二个名字。一条不分词性的规则会在这里报 30 条误报，
   * 而误报会把真漂移埋掉——本轮实测：那 30 条一度盖住了 9 条真的
   * （`Passage` 5 处、`Permission` 4 处）。
   *
   * 所以这些词只在 `struct X` / `enum X` / `type X` / `: X` 这类**命名**位置
   * 才失败，散文与动词放行。
   */
  readonly typeNameOnly?: readonly string[];
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
      "crates/refrain-core/src/material_listing.rs",
      "crates/refrain-store/src/project/",
      "crates/refrain-app/src/material_access.rs",
    ],
  },
  {
    concept: "检索命中",
    canonical: "SearchHit（交出去的）/ ScoredHit（打分中间态，借用索引）",
    synonyms: [],
    typeNameOnly: ["Match", "Found", "Result"],
    scope: ["crates/refrain-store/src/files/search.rs"],
    except: ["PathMatch"],
    note: "PathMatch 是排序信号的名字，不是命中本身",
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
    scope: [
      "crates/refrain-core/src/material_listing.rs",
      "crates/refrain-app/src/material_access.rs",
    ],
  },
];

const files: string[] = [];
// 扫描面覆盖两种语言，而不是只有 `.rs`。
//
// 今天四条规则的作用域全在 `crates/` 下，因为这些概念还没有跨过桥：实测
// `document_search` 返回的是 `DocumentRow`（文档级），块级命中止于 Rust 层，
// 于是前端 132 个文件 22,701 行里，Fragment / Snippet / Match / Hit / Disclosure
// 各出现 **0** 次。前端没有这些词不是漏检，是它还没有这个概念可谈。
//
// 但扫描面写死成 `.rs` 是**沉默的**：块级命中接线到前端的那一天，前端可以自由
// 地把它叫成 `Match`，而这道门禁一个字都不会说。所以扫描面跟随概念的实际位置，
// 而不是跟随今天恰好的位置——判据是写法，不是漏网名单。
//
// 这不会立出一条永远不触发的规则：作用域仍然只写概念现在住的地方，扩到前端的
// 那一步是加一条作用域路径，不是改这里。
for await (const file of new Glob("{crates,apps,packages}/**/*.{rs,ts,tsx}").scan({ cwd: "." })) {
  const normalised = file.split(/[/\\]/).join("/");
  if (normalised.includes("node_modules/") || normalised.includes("/target/")) continue;
  files.push(normalised);
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
      // 大小写都要查。同义词表写的是类型名（`Fragment`），而漂移最先发生在
      // **注释、局部变量、测试函数名**里——那些地方是小写。实测：术语收敛那一轮
      // 之后，`material_access.rs` 仍留着 `MAX_FRAGMENTS`、`allows_passages`、
      // 一句说 `OutlineOnly never contributes a fragment` 的文档注释，以及三个
      // `a_fragment_…` 的测试名，而这道门禁全程绿着——它只认大写。
      //
      // 词首字母大小写不敏感，其余保持原样：这样 `Fragment` 与 `fragment` 都咬，
      // 而 `defragment` 不会（`\b` 管住了词界）。
      const head = `[${synonym[0]!.toUpperCase()}${synonym[0]!.toLowerCase()}]`;
      const pattern = new RegExp(`\\b${head}${synonym.slice(1)}`);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (rule.except?.some((allowed) => line.includes(allowed))) return;
        failures.push(
          `${file}:${index + 1}  「${rule.concept}」只用 ${rule.canonical}，` +
            `这里出现了同义词 ${synonym}\n      ${line.trim()}`,
        );
      });
    }
    // 只在命名位置才算漂移的那一类。
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
