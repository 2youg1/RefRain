#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { readFileSync } from "node:fs";
/**
 * Keeps the rejected editor kernel (ProseMirror) out of dependencies and
 * runtime code. The decision it once guarded — direct DOM against ProseMirror —
 * went with the DOM surface, and so did the falsifying-corpus probe that pinned
 * it; what remains load-bearing is that the rejected dependency never returns
 * through a build tool. Injection proof: add `prosemirror-view` to any
 * package.json and this exits 1 naming the file.
 */

import { collect } from "./gate-lib.ts";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const failures: string[] = [];
const manifests = collect(["package.json", "apps/*/package.json", "packages/*/package.json"]);
for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as PackageManifest;
  for (const group of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const name of Object.keys(group ?? {})) {
      if (name.startsWith("prosemirror-")) failures.push(`${file}: rejected dependency ${name}`);
    }
  }
}

const sources = collect(["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "scripts/**/*.ts"]).filter(
  (file) => file !== "scripts/verify-editor-kernel.ts" && file !== "scripts/prove-gates-bite.ts",
);
for (const file of sources) {
  if (/\bprosemirror(?:-|\b)/i.test(readFileSync(file, "utf8"))) {
    failures.push(`${file}: rejected ProseMirror runtime reference`);
  }
}

if (manifests.length === 0 || sources.length === 0) {
  failures.push(`empty scan: ${manifests.length} manifests and ${sources.length} source files`);
}
if (failures.length > 0) {
  console.error("FAIL  verify:editor-kernel: rejected editor kernel resurfaced");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}
console.log(
  `PASS  verify:editor-kernel  (${manifests.length} manifests, ${sources.length} source files)`,
);
