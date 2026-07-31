#!/usr/bin/env bun
/**
 * Repository prose is an allowlist, not a blocklist.
 *
 * The old shape of this gate named one file (SPEC.md) and refused that one.
 * A blocklist only ever catches the leak someone already thought of, and the
 * documents that actually reach a repository by accident are the ones nobody
 * named in advance: a manuscript used while debugging, a plan, an audit note,
 * a memo pasted from a chat.
 *
 * So the rule is inverted. Every tracked Markdown file must appear in the list
 * below. A new one fails this gate until a human adds it here deliberately.
 *
 * This matters more for RefRain than for most projects: the files a
 * contributor has open while debugging are manuscripts and notes — the most
 * private things on their disk.
 *
 * Injection proof that this gate bites: `git add -f any-other.md` and this
 * exits 1. `git add -f SPEC.md` also exits 1, which is the old behaviour kept.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Every Markdown file the repository publishes, and why it exists.
 * Adding a row is a deliberate act: the file becomes public and stays public
 * in the history.
 */
const PUBLISHED = {
  "README.md": "what RefRain is, and how to install it",
  "docs/ARCHITECTURE.md": "modules, glossary, and where problems live",
  "docs/CONTRIBUTING.md": "how to propose a change",
  "docs/ROADMAP.md": "what is planned",
  "docs/AGENTS.md": "working discipline for agents",
  "docs/SKILL.md": "the agent protocol (generated)",
} as const satisfies Record<string, string>;

const failures: string[] = [];

const tracked = spawnSync("git", ["ls-files", "--", "*.md"], { encoding: "utf8" });
if (tracked.status !== 0 || tracked.stdout === null) {
  const reason = tracked.error?.message ?? tracked.stderr?.trim() ?? "unknown";
  console.error(`FAIL  verify:no-spec-upload: git ls-files failed: ${reason}`);
  process.exit(1);
}

const found = tracked.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

// A scan that finds nothing is a broken scan, not a clean repository: this
// file itself proves at least one Markdown document is tracked.
if (found.length === 0) {
  console.error("FAIL  verify:no-spec-upload: found 0 tracked Markdown files — the scan is broken");
  process.exit(1);
}

const allowed = new Set(Object.keys(PUBLISHED));

for (const file of found) {
  if (!allowed.has(file)) {
    failures.push(
      `${file} is tracked but not in the published set — ` +
        "if it is yours, run `git rm --cached` on it; " +
        "if it belongs to the project, add it to PUBLISHED in this file",
    );
  }
}

// The allowlist must also describe reality: a row naming a file that no longer
// exists lets a future rename pass unnoticed.
for (const file of allowed) {
  if (!found.includes(file)) {
    failures.push(`${file} is in the published set but is not tracked by git`);
  }
}

// SPEC.md is the local design authority. It must stay both untracked and
// ignored: an ignore edit and an index edit can fail separately.
const ignored = spawnSync("git", ["check-ignore", "-q", "SPEC.md"]);
if (ignored.status !== 0) {
  failures.push(
    "SPEC.md is not covered by .gitignore — " +
      "it is untracked today and one `git add .` away from not being",
  );
}

if (failures.length > 0) {
  console.error("FAIL  verify:no-spec-upload: the repository publishes prose it should not");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

const present = existsSync("SPEC.md");
console.log(
  `PASS  verify:no-spec-upload  (${found.length} published documents; ` +
    `local SPEC.md ${present ? "present, ignored, untracked" : "absent"})`,
);
