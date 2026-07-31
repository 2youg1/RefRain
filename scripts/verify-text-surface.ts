#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { Glob } from "bun";

const listed = spawnSync("git", ["ls-files", "*.md", "*.html"], { encoding: "utf8" });
if (listed.status !== 0) {
  console.error(`FAIL  verify:text-surface: git ls-files failed: ${listed.stderr.trim()}`);
  process.exit(1);
}

const tracked = new Set(
  listed.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file !== ""),
);
const files = new Set(tracked);
const excluded = /(^|\/)(\.git|node_modules|target|dist)(\/|$)/;
for await (const file of new Glob("**/*.{md,html}").scan({ cwd: ".", dot: true })) {
  const normalised = file.split(/[/\\]/).join("/");
  if (!excluded.test(normalised)) files.add(normalised);
}

const localSpecIsIgnored =
  !tracked.has("SPEC.md") && spawnSync("git", ["check-ignore", "-q", "SPEC.md"]).status === 0;
/*
 * KL9 2026-07-30：「不要往项目文件夹里塞任何 md/html 除了 license」。
 *
 * 剩下的例外都不是散文：index.html 是应用入口（构建必需），tests/corpora 是块扫描器
 * 的测试语料（它们碰巧是 .md，因为被解析的就是 Markdown），README/AGENTS 是仓库的
 * 门面与给 agent 的说明。设计文档、色表、预览页一律写到仓库之外——留在里面就成了
 * 第二权威，跟着代码漂，而下一个人不知道该信哪一份。
 *
 * SKILL.md 是 KL9 2026-07-31 点名加入的第四份：它告诉 agent 这个软件怎么运作、
 * 请求是怎么编出来的、它的回复会被怎么渲染。它之所以不违反上面那条理由，是因为
 * 它**不是手写的**——由 `cargo run -p refrain-core --example generate_skill_doc`
 * 从 `agent_protocol::skill_doc()` 生成，而那正是编译器给 agent 的同一份契约。
 * 手写副本漂移过：它教 agent 写 version="1"（解析器要 "2"，照做的 agent 每轮被拒），
 * 且完全没提 <material-draft>。`verify:skill-doc-current` 守着这份生成关系。
 * CONTRIBUTING 与 ARCHITECTURE 是 KL9 2026-07-31 加入的第五、六份，理由与前四份
 * 同类而非例外：它们是**面向仓库外部的人与 agent** 的门面，不是设计文档。
 * CONTRIBUTING 说的是「怎么提一个改动」（PR 三段式、注入验证的义务、四件检查），
 * ARCHITECTURE 说的是「问题最可能在哪个模块、模块之间怎么连、这个项目用哪些词」——
 * 后者内含 Glossary，正是为了让 agent 不再造出与本项目不同的术语。
 *
 * 它们不构成第二权威的判据是可检查的：里面的每个数字与版本号都取自代码与
 * manifest，且门禁 `verify:one-word-per-concept` 守着术语本身。设计过程、
 * 色表、预览页仍然一律写到仓库之外。
 */
const allowed = (file: string): boolean =>
  /^(README|AGENTS|ROADMAP|SKILL|CONTRIBUTING|ARCHITECTURE)\.md$/.test(file) ||
  file === "apps/desktop/index.html" ||
  /^tests\/corpora\/[^/]+\.md$/.test(file) ||
  /^probe-results\/[^/]+\.md$/.test(file) ||
  /(?:^|\/)(LICENSES|ATTRIBUTIONS)\.md$/.test(file) ||
  // 许可是 KL9 唯一点名保留的一类。
  /(?:^|\/)LICENSES?[.-][^/]*\.(md|html)$/i.test(file) ||
  // 生成的机器资产，与 themes.css 同一份数据、同一个脚本产出。它取代了一份
  // 34KB 的 HTML 预览页——要回答的问题只有「每个变量什么颜色、对比够不够」，
  // 那是一张表，不需要一个自带 CSS 的仿制窗口。
  (file === "SPEC.md" && localSpecIsIgnored);
const forbidden = [...files].filter((file) => !allowed(file)).sort();

if (forbidden.length > 0) {
  console.error("FAIL  verify:text-surface: repository prose exceeds the approved surface");
  for (const file of forbidden) console.error(`      ${file}`);
  process.exit(1);
}

console.log(`PASS  verify:text-surface  (${files.size} Markdown files on disk or in the index)`);
