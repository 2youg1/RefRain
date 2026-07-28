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
  /(?:^|\/)(LICENSES|ATTRIBUTIONS)\.md$/.test(file) ||
  (file === "SPEC.md" && localSpecIsIgnored);
const forbidden = [...files].filter((file) => !allowed(file)).sort();

if (forbidden.length > 0) {
  console.error("FAIL  verify:text-surface: repository prose exceeds the approved surface");
  for (const file of forbidden) console.error(`      ${file}`);
  process.exit(1);
}

console.log(`PASS  verify:text-surface  (${files.size} Markdown files on disk or in the index)`);
