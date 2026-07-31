#!/usr/bin/env bun
import { existsSync } from "node:fs";
/**
 * The local design baseline never reaches the repository.
 *
 * SPEC.md is the local design authority, not part of the public repository.
 * A `.gitignore` entry is the mechanism; this script asserts that the mechanism
 * still works because an ignore edit and an index edit can fail separately.
 *
 * Injection proof that this gate bites: `git add -f SPEC.md` and this exits 1.
 */

import { spawnSync } from "node:child_process";

const tracked = spawnSync("git", ["ls-files", "--", "SPEC.md"], { encoding: "utf8" });
if (tracked.status !== 0) {
  console.error(`FAIL  verify:no-spec-upload: git ls-files failed: ${tracked.stderr.trim()}`);
  process.exit(1);
}

if (tracked.stdout.trim() !== "") {
  console.error("FAIL  verify:no-spec-upload: SPEC.md is tracked by git");
  console.error("      The design baseline stays local. Run: git rm --cached SPEC.md");
  process.exit(1);
}

// The ignore rule must also be present, or the next `git add .` tracks it.
const ignored = spawnSync("git", ["check-ignore", "-q", "SPEC.md"]);
if (ignored.status !== 0) {
  console.error("FAIL  verify:no-spec-upload: SPEC.md is not covered by .gitignore");
  console.error("      It is untracked today and one `git add .` away from not being.");
  process.exit(1);
}

const present = existsSync("SPEC.md");
console.log(
  present
    ? "PASS  verify:no-spec-upload  (local SPEC.md present, ignored, untracked)"
    : "PASS  verify:no-spec-upload  (local SPEC.md optional; ignore rule and index are clean)",
);
