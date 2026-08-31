#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * The agent entry chain must be unbreakable: root `CLAUDE.md` imports
 * `docs/AGENTS.md`, root `AGENTS.md` points at it, and the four
 * "What green does not prove" rules stay pinned inside it.
 *
 * Why a gate: a Claude Code session loads only root `CLAUDE.md`; other
 * harnesses load only root `AGENTS.md`. If either stub goes missing, or
 * `CLAUDE.md` loses its `@docs/AGENTS.md` import line, that session starts
 * with no rules at all — and the rules most likely to be "cleaned up" by a
 * later agent are exactly the four scars that explain why green builds have
 * shipped broken. Deleting a rule there requires editing this gate in the
 * same commit, which is the deliberate act the rule demands.
 *
 * The stubs stay stubs: content beyond the pointer lines would be a second
 * rule authority that drifts from docs/AGENTS.md, so growth fails here.
 *
 * Injection proof that this gate bites:
 *   1. Remove `CLAUDE.md`, or its `@docs/AGENTS.md` line → red, naming the file.
 *   2. Remove root `AGENTS.md`, or its `docs/AGENTS.md` reference → red.
 *   3. Remove "### What green does not prove" or any one of its four rules
 *      from docs/AGENTS.md → red, naming the missing rule.
 */

import { existsSync, readFileSync } from "node:fs";

const failures: string[] = [];

/** A pointer stub earns its name by staying one: pointers, no second rulebook. */
const STUB_LINE_BUDGET = 6;

function nonEmptyLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// ---- root CLAUDE.md: the Claude Code entry -------------------------------
if (!existsSync("CLAUDE.md")) {
  failures.push(
    "CLAUDE.md is missing at the repository root: a Claude Code session would start with no rules",
  );
} else {
  const claude = readFileSync("CLAUDE.md", "utf8");
  const lines = nonEmptyLines(claude);
  if (!lines.includes("@docs/AGENTS.md")) {
    failures.push(
      'CLAUDE.md lost its "@docs/AGENTS.md" import line: Claude Code would load the stub and none of the rules',
    );
  }
  if (lines.length > STUB_LINE_BUDGET) {
    failures.push(
      `CLAUDE.md holds ${lines.length} non-empty lines (budget ${STUB_LINE_BUDGET}): content belongs in docs/AGENTS.md, not in a second authority`,
    );
  }
}

// ---- root AGENTS.md: the entry for every other harness -------------------
if (!existsSync("AGENTS.md")) {
  failures.push(
    "AGENTS.md is missing at the repository root: a non-Claude harness would start with no rules",
  );
} else {
  const stub = readFileSync("AGENTS.md", "utf8");
  const lines = nonEmptyLines(stub);
  if (!stub.includes("docs/AGENTS.md")) {
    failures.push(
      "root AGENTS.md no longer points at docs/AGENTS.md: the pointer stub points nowhere",
    );
  }
  if (lines.length > STUB_LINE_BUDGET) {
    failures.push(
      `root AGENTS.md holds ${lines.length} non-empty lines (budget ${STUB_LINE_BUDGET}): content belongs in docs/AGENTS.md, not in a second authority`,
    );
  }
}

// ---- docs/AGENTS.md: the one rulebook, with the four scars pinned --------
if (!existsSync("docs/AGENTS.md")) {
  failures.push("docs/AGENTS.md is missing: both root stubs point at nothing");
} else {
  const rules = readFileSync("docs/AGENTS.md", "utf8");
  if (!rules.includes("### What green does not prove")) {
    failures.push(
      'docs/AGENTS.md lost the "What green does not prove" section: the four shipped-green-but-broken scars are unpinned',
    );
  }
  /** One stable anchor per pinned rule; rewording keeps the anchor or edits this gate in the same commit. */
  const anchors: ReadonlyArray<readonly [string, string]> = [
    ["rule 1 (compose)", "assert the composed"],
    ["rule 2 (author-visible)", "what the author sees"],
    ["rule 3 (short-circuited paths)", "short-circuit"],
    ["rule 4 (release predicate)", "author's flow in a real window"],
  ];
  for (const [name, anchor] of anchors) {
    if (!rules.includes(anchor)) {
      failures.push(`docs/AGENTS.md lost ${name}: anchor "${anchor}" not found`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL  verify:agent-entry: ${failure}`);
  }
  process.exit(1);
}

console.log(
  "PASS  verify:agent-entry: entry stubs point home and the four pinned rules are present",
);
