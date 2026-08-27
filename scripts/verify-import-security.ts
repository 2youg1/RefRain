#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ingest = readFileSync("crates/refrain-store/src/ingest.rs", "utf8");
const office = readFileSync("crates/refrain-store/src/ingest/office.rs", "utf8");
const pdf = readFileSync("crates/refrain-store/src/ingest/pdf.rs", "utf8");
const materials = readFileSync("crates/refrain-store/src/materials.rs", "utf8");
const failures: string[] = [];

for (const [source, fact, failure] of [
  [ingest, "MAX_SOURCE_BYTES", "source files have no hard byte limit"],
  [ingest, ".take(MAX_SOURCE_BYTES + 1)", "source reads are not bounded"],
  [ingest, "MAX_EXTRACTED_TEXT_BYTES", "projected text has no hard limit"],
  [office, "MAX_ARCHIVE_MEMBERS", "ZIP member count is unbounded"],
  [office, "MAX_MEMBER_BYTES", "ZIP members have no individual limit"],
  [office, "MAX_ARCHIVE_TEXT_BYTES", "ZIP expansion has no total limit"],
  [office, "MAX_COMPRESSION_RATIO", "ZIP compression ratio is unchecked"],
  [office, "if !family.needs(&name)", "irrelevant ZIP members are still expanded"],
  [office, "duplicate member", "duplicate normalised member names are accepted"],
  [pdf, "MAX_PDF_PAGES", "PDF page count is unbounded"],
  [pdf, "MAX_PDF_PAGE_CONTENT_BYTES", "PDF page content is unbounded"],
  [pdf, "operation.operands.as_slice()", "PDF positioning operators still use unchecked indexes"],
  [
    materials,
    "crate::ingest::read_source(source)",
    "source cloning bypasses the source byte limit",
  ],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
}

if (failures.length === 0) {
  const result = spawnSync("cargo", ["test", "-p", "refrain-store", "ingest::"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    failures.push("the live ingestion refusal tests failed");
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:import-security");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:import-security  (4 targets; bounded source, archive and PDF paths)");
