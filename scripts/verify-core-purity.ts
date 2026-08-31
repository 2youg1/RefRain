#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * SPEC 6.2: refrain-core is pure domain.
 *
 * No tauri, no rusqlite, no filesystem writes, no processes. The boundary is
 * what lets the domain be tested without a window and reasoned about without a
 * database — and it erodes one convenient import at a time.
 *
 * Injection proof that this gate bites: add `use std::fs;` to any core module
 * and this exits 1 naming the file and line.
 */

import { report, scan } from "./gate-lib.ts";

const FORBIDDEN =
  /^\s*use\s+(tauri|rusqlite|std::fs|std::process|std::net|std::path::PathBuf)\b|\bstd::fs::(write|create|remove|rename|copy|File::create)\b/;

const result = scan(["crates/refrain-core/src/**/*.rs"], FORBIDDEN, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
});

// refrain-app holds the multi-step flows, so it may reach the store and the
// filesystem — but not Tauri. That is the whole reason it exists: collecting a
// dispatch was a 182-line command body that no test could reach without a
// window. Its Cargo.toml says "Nothing here knows about Tauri"; this is the
// sentence's gate.
//
// Injection proof: add `use tauri::State;` to any module under
// crates/refrain-app/src and this exits 1 naming the file and line.
const appResult = scan(["crates/refrain-app/src/**/*.rs"], /^\s*use\s+tauri\b/, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
});

// Plan v0.2.3 §4.1: the server form has to be possible later, and that depends
// on exactly one property — refrain-core, refrain-store and refrain-host do not
// need a window. Today that is already true (measured: zero `tauri::` in all
// three). This gate is not here to establish it. It is here so it still holds
// tomorrow, because a comment stops no import.
//
// Two layers, because they fail differently. A `use` line is the common way in.
// A window type named in a signature (`fn f(w: tauri::Window)`) never writes
// `use tauri` at all, so the manifest is the load-bearing check: a crate that
// cannot depend on tauri cannot name its types anywhere.
//
// refrain-core is absent from the source list on purpose: FORBIDDEN above
// already owns its `use tauri` line, and listing it twice makes one injected
// import print two identical findings — a reader cannot tell that from two
// separate violations. Each line is reported by exactly one rule.
const WINDOWLESS_MANIFESTS = ["refrain-core", "refrain-store", "refrain-host"] as const;

const windowlessSource = scan(
  ["crates/refrain-store/src/**/*.rs", "crates/refrain-host/src/**/*.rs"],
  /\btauri(_runtime|_plugin_\w+)?::|^\s*use\s+tauri\b/,
  { ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line) },
);

// Injection proof: add `tauri = "2"` under [dependencies] in any of the three
// manifests and this exits 1 naming the file and line. The comment on
// refrain-core/Cargo.toml line 9 states this rule in prose; this is its gate.
const windowlessManifest = scan(
  WINDOWLESS_MANIFESTS.map((crate) => `crates/${crate}/Cargo.toml`),
  /^\s*tauri\b\s*=/,
  { ignoreLine: (line) => /^\s*#/.test(line) },
);

// A gate that scans nothing passes. These counts are fixed by the workspace
// layout, so state them: three manifests, and the two crate source trees.
if (windowlessManifest.scanned !== WINDOWLESS_MANIFESTS.length) {
  console.error(
    `FAIL  verify:core-purity: expected ${WINDOWLESS_MANIFESTS.length} manifests, scanned ${windowlessManifest.scanned}`,
  );
  process.exit(1);
}
if (windowlessSource.scanned === 0) {
  console.error("FAIL  verify:core-purity: the windowless source scan matched no files");
  process.exit(1);
}

report(
  "verify:core-purity",
  {
    scanned:
      result.scanned + appResult.scanned + windowlessSource.scanned + windowlessManifest.scanned,
    findings: [
      ...result.findings,
      ...appResult.findings,
      ...windowlessSource.findings,
      ...windowlessManifest.findings,
    ],
  },
  "a crate reaches a dependency its layer must not know about",
);
