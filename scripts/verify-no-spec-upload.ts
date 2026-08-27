#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository prose is an allowlist, not a blocklist.
 *
 * The old shape of this gate named one file (SPEC.md) and refused that one.
 * A blocklist only ever catches the leak someone already thought of, and the
 * documents that actually reach a repository by accident are the ones nobody
 * named in advance: a manuscript used while debugging, a plan, an audit note,
 * a memo pasted from a chat.
 *
 * So the rule is inverted. Every tracked `.md` and `.html` file must appear in
 * the list below. A new one fails this gate until a human adds it here
 * deliberately.
 *
 * `.html` is here because it was covered until the Native rewrite deleted the
 * gate that covered it (`verify:text-surface`, 46d9f9b), while
 * `published-documents.ts` went on naming that gate as a live reader. A rendered
 * chapter, an exported draft and a saved web page are all `.html`, and all three
 * are the kind of file this gate exists to keep out of a public history.
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
import { PUBLISHED } from "./published-documents";

const failures: string[] = [];

const tracked = spawnSync("git", ["ls-files", "--", "*.md", "*.html"], { encoding: "utf8" });
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
// repository's own README proves at least one such document is tracked. The
// floor stays on the combined set, because zero tracked `.html` is the correct
// and expected reading here — only zero of both means the scan face moved.
if (found.length === 0) {
  console.error(
    "FAIL  verify:no-spec-upload: found 0 tracked .md or .html files — the scan is broken",
  );
  process.exit(1);
}

const allowed = new Set(Object.keys(PUBLISHED));

for (const file of found) {
  if (!allowed.has(file)) {
    failures.push(
      `${file} is tracked but not in the published set — ` +
        "if it is yours, run `git rm --cached` on it; " +
        "if it belongs to the project, add it to scripts/published-documents.ts",
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
