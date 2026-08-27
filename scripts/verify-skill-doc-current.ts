#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const committedPath = "docs/SKILL.md";
const scratch = mkdtempSync(join(tmpdir(), "refrain-skill-"));
const generatedPath = join(scratch, "SKILL.md");
const generated = spawnSync(
  "cargo",
  ["run", "--quiet", "-p", "refrain-core", "--example", "generate_skill_doc", "--", generatedPath],
  { encoding: "utf8" },
);

if (generated.status !== 0) {
  console.error("FAIL  verify:skill-doc-current: cannot generate the protocol document");
  console.error((generated.stderr ?? generated.error?.message ?? "cargo did not run").trim());
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const expected = readFileSync(generatedPath, "utf8");
rmSync(scratch, { recursive: true, force: true });
const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : null;

if (committed === null) {
  console.error(`FAIL  verify:skill-doc-current: ${committedPath} is missing`);
  console.error(
    `      run: cargo run -p refrain-core --example generate_skill_doc -- ${committedPath}`,
  );
  process.exit(1);
}

if (committed.trim() !== expected.trim()) {
  console.error(`FAIL  verify:skill-doc-current: ${committedPath} has drifted from skill_doc()`);
  console.error(
    `      regenerate: cargo run -p refrain-core --example generate_skill_doc -- ${committedPath}`,
  );
  const left = committed.trim().split("\n");
  const right = expected.trim().split("\n");
  for (let line = 0; line < Math.max(left.length, right.length); line += 1) {
    if (left[line] !== right[line]) {
      console.error(`      first difference at line ${line + 1}:`);
      console.error(`        committed: ${left[line] ?? "(end of file)"}`);
      console.error(`        protocol:  ${right[line] ?? "(end of file)"}`);
      break;
    }
  }
  process.exit(1);
}

console.log(
  `PASS  verify:skill-doc-current  (${expected.length} bytes, generated from skill_doc())`,
);
