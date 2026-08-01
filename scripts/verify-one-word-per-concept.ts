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
];

const files: string[] = [];
// Include both implementation languages before applying concept scopes.
for await (const file of new Glob("{crates,apps,packages}/**/*.{rs,ts,tsx}").scan({ cwd: "." })) {
  const normalised = file.split(/[/\\]/).join("/");
  if (normalised.includes("node_modules/") || normalised.includes("/target/")) continue;
  files.push(normalised);
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
      // Match either initial case at a word boundary.
      const first = synonym.charAt(0);
      if (first === "") {
        failures.push(`规则「${rule.concept}」包含空同义词`);
        continue;
      }
      const head = `[${first.toUpperCase()}${first.toLowerCase()}]`;
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
