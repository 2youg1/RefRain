#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { Glob } from "bun";

const listed = spawnSync("git", ["ls-files", "*.md"], { encoding: "utf8" });
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
for await (const file of new Glob("**/*.md").scan({ cwd: ".", dot: true })) {
  const normalised = file.split(/[/\\]/).join("/");
  if (!excluded.test(normalised)) files.add(normalised);
}

const localSpecIsIgnored =
  !tracked.has("SPEC.md") && spawnSync("git", ["check-ignore", "-q", "SPEC.md"]).status === 0;
const allowed = (file: string): boolean =>
  /^(README|AGENTS|ROADMAP)\.md$/.test(file) ||
  /^tests\/corpora\/[^/]+\.md$/.test(file) ||
  /^probe-results\/[^/]+\.md$/.test(file) ||
  /(?:^|\/)(LICENSES|ATTRIBUTIONS)\.md$/.test(file) ||
  // 生成的机器资产，与 themes.css 同一份数据、同一个脚本产出。它取代了一份
  // 34KB 的 HTML 预览页——要回答的问题只有「每个变量什么颜色、对比够不够」，
  // 那是一张表，不需要一个自带 CSS 的仿制窗口。
  file === "apps/desktop/theme-colours.md" ||
  (file === "SPEC.md" && localSpecIsIgnored);
const forbidden = [...files].filter((file) => !allowed(file)).sort();

if (forbidden.length > 0) {
  console.error("FAIL  verify:text-surface: repository prose exceeds the approved surface");
  for (const file of forbidden) console.error(`      ${file}`);
  process.exit(1);
}

console.log(`PASS  verify:text-surface  (${files.size} Markdown files on disk or in the index)`);
