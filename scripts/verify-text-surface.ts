#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { Glob } from "bun";

const approvedDocuments = new Set([
  "README.md",
  "docs/AGENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/CONTRIBUTING.md",
  "docs/ROADMAP.md",
  "docs/SKILL.md",
]);

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
  const normalised = file.replaceAll("\\", "/");
  if (!excluded.test(normalised)) files.add(normalised);
}

const failures: string[] = [];
for (const expected of approvedDocuments) {
  if (!tracked.has(expected)) failures.push(`missing approved document: ${expected}`);
}
for (const licence of ["LICENSE", "LICENSE-THIRD-PARTY"]) {
  if (!(await Bun.file(licence).exists())) failures.push(`missing licence file: ${licence}`);
}

const localSpecIsIgnored =
  !tracked.has("SPEC.md") && spawnSync("git", ["check-ignore", "-q", "SPEC.md"]).status === 0;
const allowed = (file: string): boolean =>
  approvedDocuments.has(file) ||
  file === "apps/desktop/index.html" ||
  /^tests\/corpora\/[^/]+\.md$/.test(file) ||
  /(?:^|\/)(LICENSES|ATTRIBUTIONS)\.md$/.test(file) ||
  /(?:^|\/)LICENSES?[.-][^/]*\.(md|html)$/i.test(file) ||
  (file === "SPEC.md" && localSpecIsIgnored);

for (const file of [...files].sort()) {
  if (!allowed(file)) failures.push(`unapproved prose path: ${file}`);
}

if (failures.length > 0) {
  console.error("FAIL  verify:text-surface: repository prose differs from the approved surface");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:text-surface  (${approvedDocuments.size} public documents in approved paths)`,
);
