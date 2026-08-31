#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * D-01…D-04: what the documents say about their own state, checked against the
 * state.
 *
 * This repository already gates the documents it *generates* — `verify:docs-current`,
 * `verify:skill-doc-current`, the protocol `--check`, `verify:themes-current`.
 * Nothing read the numbers a document states about the code beside it, and all
 * four such numbers had drifted at once: a layer's line count, the reply slot
 * count, how many journals verify, and a lint total that `Cargo.toml` published
 * twice with two different values in one file.
 *
 * The four claims below share one property: each is a number or a set that some
 * file already decides, so the document is a copy and copies drift. The gate
 * does not judge the prose. It recomputes the fact and demands the sentence
 * agree.
 *
 * **What this costs.** The scale column moves whenever a layer gains or loses
 * lines, so a commit that edits Rust will sometimes have to edit one number in
 * `ARCHITECTURE.md`. That is the price of publishing a number instead of only a
 * command, and the failure message prints the replacement text so paying it is
 * a copy and paste. The alternative — deleting the column — was rejected because
 * the relative size of the six layers is the fastest orientation a new reader
 * gets.
 *
 * Injection proof that this gate bites, one per branch:
 *   - change any line count in the layer table → red (branch 1)
 *   - change "14 slots" in the `core/replies.zig` row → red (branch 2)
 *   - set one journal's tier to `no-verify` without an Open item that waits on
 *     the tier table, or the reverse → red (branch 3)
 *   - change one of the six lint counts in `Cargo.toml` only → red (branch 4)
 */

import { readFileSync } from "node:fs";

import { collect } from "./gate-lib.ts";
import { journalPlans } from "./native-journals.ts";

const ARCHITECTURE = "docs/ARCHITECTURE.md";
const CARGO = "Cargo.toml";
const REPLIES = "apps/native/src/core/replies.zig";

const architecture = readFileSync(ARCHITECTURE, "utf8");
const failures: string[] = [];

/** A published integer, written with the thousands separators the document uses. */
const published = (text: string): number => Number.parseInt(text.replaceAll(",", ""), 10);
const grouped = (value: number): string => value.toLocaleString("en-US");

// —— 分支 1：层规模列 ——————————————————————————————————————————————
//
// The rule the document states beside the column: every hand-written source
// file of that layer, the crate root included, and no generated file. The two
// layers that hold generated code beside the hand-written kind name it here, so
// the exclusion is one decision rather than a habit each reader must infer.
const LAYERS: readonly { readonly row: string; readonly sources: readonly string[] }[] = [
  { row: "L0 `refrain-core`", sources: ["crates/refrain-core/src/**/*.rs"] },
  { row: "L1 `refrain-store`", sources: ["crates/refrain-store/src/**/*.rs"] },
  { row: "L2 `refrain-host`", sources: ["crates/refrain-host/src/**/*.rs"] },
  { row: "L3 `refrain-app`", sources: ["crates/refrain-app/src/**/*.rs"] },
  { row: "L4 `apps/native/host`", sources: ["apps/native/host/src/**/*.rs"] },
  { row: "L5 `apps/native/src`", sources: ["apps/native/src/**/*.zig"] },
];

/** The generated files that sit beside hand-written code, by the layer that holds them. */
const GENERATED: Readonly<Record<string, readonly string[]>> = {
  "L4 `apps/native/host`": ["apps/native/host/src/wire.rs", "apps/native/host/src/protocol.rs"],
  "L5 `apps/native/src`": ["apps/native/src/generated/**/*"],
};

const measure = (patterns: readonly string[], excluded: ReadonlySet<string>) => {
  const files = collect(patterns).filter((file) => !excluded.has(file));
  const lines = files.reduce(
    (total, file) => total + readFileSync(file, "utf8").split("\n").length - 1,
    0,
  );
  return { modules: files.length, lines };
};

for (const layer of LAYERS) {
  const excluded = new Set(collect(GENERATED[layer.row] ?? []));
  const actual = measure(layer.sources, excluded);
  if (actual.modules === 0) {
    failures.push(`${layer.row}: the scale rule matched no file — the scan face moved`);
    continue;
  }
  const row = new RegExp(
    `^\\| \\*\\*${layer.row.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}\\*\\*.*\\| (?<modules>[\\d,]+) / (?<lines>[\\d,]+) \\|$`,
    "m",
  ).exec(architecture)?.groups;
  if (row === undefined) {
    failures.push(`${ARCHITECTURE}: no scale cell found for ${layer.row}`);
    continue;
  }
  if (
    published(row.modules ?? "") !== actual.modules ||
    published(row.lines ?? "") !== actual.lines
  ) {
    failures.push(
      `${ARCHITECTURE}: ${layer.row} publishes ${row.modules} / ${row.lines}; write ${grouped(actual.modules)} / ${grouped(actual.lines)}`,
    );
  }
}

// The generated line counts the same paragraph publishes, under the same rule.
// The sentence wraps, so it is matched against whitespace-flattened prose.
const flattened = architecture.replaceAll(/\s+/g, " ");
for (const [row, patterns] of Object.entries(GENERATED)) {
  const label = row.startsWith("L4") ? "L4" : "L5";
  const claim =
    label === "L4"
      ? /L4 carries `wire\.rs` and `protocol\.rs` \((?<lines>[\d,]+) lines\)/.exec(flattened)
          ?.groups?.lines
      : /L5 carries `generated\/` \((?<lines>[\d,]+)\)/.exec(flattened)?.groups?.lines;
  if (claim === undefined) {
    failures.push(`${ARCHITECTURE}: no generated line count found for ${label}`);
    continue;
  }
  const actual = measure(patterns, new Set());
  if (published(claim) !== actual.lines) {
    failures.push(
      `${ARCHITECTURE}: ${label} publishes ${claim} generated lines; write ${grouped(actual.lines)}`,
    );
  }
}

// —— 分支 2：答复槽数 ——————————————————————————————————————————————
//
// `core/replies.zig` sizes its storage from `@typeInfo(Slot).@"enum".fields.len`,
// so the slot count decides how many times 40,960 bytes are reserved. A document
// that says seven while the enum says fourteen understates that by 287 KB.
const repliesSource = readFileSync(REPLIES, "utf8");
const slotBody = /pub const Slot = enum \{(?<body>[\s\S]*?)\n\};/.exec(repliesSource)?.groups?.body;
if (slotBody === undefined) {
  failures.push(`${REPLIES}: the Slot enum was not found — the scan face moved`);
} else {
  const slots = slotBody.split("\n").filter((line) => /^\s{4}[a-z_]+,$/.test(line)).length;
  const stated = /`core\/replies\.zig` \| [^|]*?(?<slots>\d+) slots/.exec(architecture)?.groups
    ?.slots;
  if (stated === undefined) {
    failures.push(`${ARCHITECTURE}: the core/replies.zig row publishes no slot count`);
  } else if (Number.parseInt(stated, 10) !== slots) {
    failures.push(`${ARCHITECTURE}: the reply row says ${stated} slots; the enum has ${slots}`);
  }
}

// —— 分支 3：journal 档位 vs Open items ————————————————————————————
//
// The tier table in `scripts/native-journals.ts` is the only authority for which
// journal can verify a fingerprint. An Open item that names that table as what
// waits on it is claiming a journal is blocked; the claim is checkable, so it is
// checked. This is what made a reader spend a session reopening M8: two
// paragraphs said it was closed, two said it was open, and the table said all
// eight journals verify.
const OPEN_ITEMS = /## Open items\n(?<body>[\s\S]*?)\nWired, but with no signature/.exec(
  architecture,
)?.groups?.body;
if (OPEN_ITEMS === undefined) {
  failures.push(`${ARCHITECTURE}: the Open items table was not found — the scan face moved`);
} else {
  const blocked = Object.entries(journalPlans).filter(([, plan]) => plan.tier.mode === "no-verify");
  const blockedBy = new Set(
    blocked.map(([, plan]) => (plan.tier.mode === "no-verify" ? plan.tier.blockedBy : "")),
  );
  for (const line of OPEN_ITEMS.split("\n")) {
    const item = /^\| \*\*(?<id>[A-Z]\d+)\*\* \|/.exec(line)?.groups?.id;
    if (item === undefined) continue;
    const waitsOnJournals = line.includes("scripts/native-journals.ts");
    const claimedByAJournal = [...blockedBy].some((reason) => reason.includes(item));
    if (waitsOnJournals && !claimedByAJournal) {
      failures.push(
        `${ARCHITECTURE}: Open item ${item} says the journal tier table waits on it, but no journal is blocked by ${item}`,
      );
    }
  }
  for (const reason of blockedBy) {
    if (!/\b[A-Z]\d+\b/.test(reason)) continue;
    const item = /\b(?<id>[A-Z]\d+)\b/.exec(reason)?.groups?.id ?? "";
    if (!OPEN_ITEMS.includes(`**${item}**`)) {
      failures.push(
        `native-journals.ts: a journal is blocked by ${item}, which is not an Open item`,
      );
    }
  }
  const total = Object.keys(journalPlans).length;
  const verifying = total - blocked.length;
  const stated = /Today (?<verifying>\d+) of the (?<total>\d+) journals verify/.exec(
    architecture,
  )?.groups;
  if (stated === undefined) {
    failures.push(`${ARCHITECTURE}: the journal section publishes no verify count`);
  } else if (
    Number.parseInt(stated.verifying ?? "", 10) !== verifying ||
    Number.parseInt(stated.total ?? "", 10) !== total
  ) {
    failures.push(
      `${ARCHITECTURE}: says ${stated.verifying} of ${stated.total} journals verify; the tier table says ${verifying} of ${total}`,
    );
  }
}

// —— 分支 4：六个 lint 计数在两个文件里说同一个数 ————————————————
//
// `Cargo.toml` published 277 in its lint note and 282 in the release profile,
// eleven lines apart, and the second pointed at the first. Neither reader could
// tell which was measured. The gate does not run clippy — that costs minutes —
// it demands the three places that state the number state the same one.
const cargo = readFileSync(CARGO, "utf8");
const architectureCounts = new Map<string, number>();
for (const match of architecture.matchAll(/^\| `(?<lint>[a-z_]+)` \| (?<count>[\d,]+) \|/gm)) {
  if (match.groups?.lint !== undefined && match.groups.count !== undefined) {
    architectureCounts.set(match.groups.lint, published(match.groups.count));
  }
}
const cargoCounts = new Map<string, number>();
for (const line of cargo.split("\n")) {
  if (!/^#\s{3}[a-z_]+\s+\d+/.test(line)) continue;
  for (const match of line.matchAll(/(?<lint>[a-z_]+)\s+(?<count>\d+)/g)) {
    if (match.groups?.lint !== undefined && match.groups.count !== undefined) {
      cargoCounts.set(match.groups.lint, Number.parseInt(match.groups.count, 10));
    }
  }
}
if (architectureCounts.size !== 6 || cargoCounts.size !== 6) {
  failures.push(
    `the lint tables no longer hold six rows each (${ARCHITECTURE}: ${architectureCounts.size}, ${CARGO}: ${cargoCounts.size}) — the scan face moved`,
  );
} else {
  for (const [lint, count] of architectureCounts) {
    const beside = cargoCounts.get(lint);
    if (beside === undefined) {
      failures.push(`${CARGO}: the lint note does not state ${lint}`);
    } else if (beside !== count) {
      failures.push(`${lint}: ${ARCHITECTURE} says ${count}, ${CARGO} says ${beside}`);
    }
  }
}
// The sentence wraps across comment lines, so it is read from flattened prose.
const prose = /(?<count>\d+) production expressions still do bare integer arithmetic/.exec(
  cargo.replaceAll(/\s*\n\s*#\s*/g, " "),
)?.groups?.count;
const arithmetic = architectureCounts.get("arithmetic_side_effects");
if (prose === undefined) {
  failures.push(`${CARGO}: the release profile no longer states the arithmetic count`);
} else if (arithmetic !== undefined && Number.parseInt(prose, 10) !== arithmetic) {
  failures.push(
    `arithmetic_side_effects: the release profile note says ${prose}, the lint tables say ${arithmetic}`,
  );
}

if (failures.length > 0) {
  console.error("FAIL  verify:doc-state");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:doc-state  (${LAYERS.length} layer scales, the reply slots, ${Object.keys(journalPlans).length} journal tiers, and 6 lint counts agree with the code)`,
);
process.exit(0);
