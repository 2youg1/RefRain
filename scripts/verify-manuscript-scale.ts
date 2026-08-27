#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// The review suite carries wall-clock budgets (INV-8: alignment stays
// bounded). Wall time only means something measured the way the artifact
// ships: a debug build on a loaded dev machine fails the same algorithm that
// passes in release, which is how this gate flaked its first week on
// Windows. Perf budgets are therefore asserted on the release profile.

const targets = [
  "crates/refrain-core/src/manuscript/align.rs",
  "crates/refrain-core/tests/review.rs",
] as const;
const missing = targets.filter((target) => !existsSync(target));
if (missing.length > 0) {
  console.error(`FAIL  verify:manuscript-scale: missing ${missing.join(", ")}`);
  process.exit(1);
}

const result = spawnSync("cargo", ["test", "--release", "-p", "refrain-core", "--test", "review"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error("FAIL  verify:manuscript-scale: crates/refrain-core/tests/review.rs");
  process.exit(result.status ?? 1);
}

console.log(`PASS  verify:manuscript-scale  (${targets.length} targets)`);
