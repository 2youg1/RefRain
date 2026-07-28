#!/usr/bin/env bun
/**
 * The local design baseline never reaches the repository.
 *
 * SPEC.md carries unpublished product judgement, competitor comparison, and
 * per-decision reasoning. It stays on the maintainer's machine (SPEC preamble,
 * section 12 R0). A `.gitignore` entry is the mechanism; this is the assertion
 * that the mechanism still works — the two fail apart, because a later edit to
 * `.gitignore` looks harmless and an accidental `git add -f` looks deliberate.
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

// Assert the file is actually here. Passing because SPEC.md is absent would be
// the empty-scan failure: the gate would go green on a machine that lost it.
const present = await Bun.file("SPEC.md").exists();
if (!present) {
  console.error("FAIL  verify:no-spec-upload: SPEC.md is not on disk — nothing was checked");
  process.exit(1);
}

console.log("PASS  verify:no-spec-upload  (SPEC.md present, ignored, untracked)");
