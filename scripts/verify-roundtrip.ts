#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * INV-5: the corpora are frozen, and every gate can find them.
 *
 * R0 freezes twenty shapes that have damaged, or could damage, an author's
 * file. The byte-for-byte roundtrip assertion lands in R1 with the text engine;
 * what this gate holds today is the asset itself — that each corpus is present
 * and still hashes to what the manifest recorded.
 *
 * A corpus that drifts stops being evidence about the defect it was cut from,
 * and it drifts silently: an editor adding a trailing newline is enough.
 *
 * Injection proof that this gate bites: append a byte to any file under
 * tests/corpora/ and this exits 1 naming it with both digests.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

interface Entry {
  readonly name: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

const manifestPath = "tests/corpora/manifest.json";
if (!existsSync(manifestPath)) {
  console.error(`FAIL  verify:roundtrip: ${manifestPath} is missing — nothing was checked`);
  process.exit(1);
}

const { corpora } = JSON.parse(readFileSync(manifestPath, "utf8")) as { corpora: Entry[] };

if (corpora.length === 0) {
  console.error("FAIL  verify:roundtrip: the manifest lists zero corpora");
  process.exit(1);
}

const failures: string[] = [];

for (const entry of corpora) {
  const corpusPath = `tests/corpora/${entry.file}`;
  if (!existsSync(corpusPath)) {
    failures.push(`${entry.file}: missing`);
    continue;
  }

  const bytes = readFileSync(corpusPath);
  const digest = createHash("sha256").update(bytes).digest("hex");

  if (digest !== entry.sha256) {
    failures.push(
      `${entry.file}: expected ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`,
    );
  } else if (bytes.length !== entry.bytes) {
    failures.push(`${entry.file}: expected ${entry.bytes} bytes, got ${bytes.length}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:roundtrip: a frozen corpus changed");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(`PASS  verify:roundtrip  (${corpora.length} corpora verified against their digests)`);
