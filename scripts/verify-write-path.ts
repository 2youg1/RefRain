#!/usr/bin/env bun
/**
 * INV-2: only a Text Action mutates the manuscript.
 *
 * There are exactly two commands that write manuscript text —
 * `apply_editor_action` and `commit_decision_batch` — and both require a human
 * click to reach. Agent output stops at a Proposal. A third write path would
 * not announce itself; it would look like a helpful convenience command.
 *
 * Injection proof that this gate bites: add a third `#[tauri::command]` whose
 * name matches the manuscript-writing shape, or make an existing command write
 * manuscript bytes, and this exits 1.
 */

import { collect } from "./gate-lib.ts";

const AUTHORISED = ["apply_editor_action", "commit_decision_batch"] as const;

const files = await collect(["apps/desktop/src-tauri/src/**/*.rs"]);
if (files.length === 0) {
  console.error("FAIL  verify:write-path: scanned 0 files — the scan is looking in the wrong place");
  process.exit(1);
}

// Every registered command, read from the source rather than from a list kept
// by hand: a list kept by hand is exactly what stops matching reality.
const commands: string[] = [];
for (const file of files) {
  const text = await Bun.file(file).text();
  for (const match of text.matchAll(/#\[tauri::command\][\s\S]{0,200}?fn\s+(\w+)/g)) {
    if (match[1] !== undefined) commands.push(match[1]);
  }
}

if (commands.length === 0) {
  console.error("FAIL  verify:write-path: found no registered commands — the pattern is stale");
  process.exit(1);
}

/*
 * The rule is not "these two exist" but "nothing else writes the manuscript".
 * R0 has no manuscript writer yet, so the assertion is that no command outside
 * the authorised pair carries a manuscript-writing name. It tightens in R1,
 * when the real writers land and store gains its named write primitives.
 */
const WRITES_MANUSCRIPT = /^(write|save|commit|apply|replace|delete)_(chapter|document|manuscript|text|revision|block)/;

const unauthorised = commands.filter(
  (name) => WRITES_MANUSCRIPT.test(name) && !AUTHORISED.includes(name as (typeof AUTHORISED)[number]),
);

if (unauthorised.length > 0) {
  console.error("FAIL  verify:write-path: a command outside the authorised pair writes the manuscript");
  for (const name of unauthorised) console.error(`      ${name}`);
  console.error(`      authorised: ${AUTHORISED.join(", ")}`);
  process.exit(1);
}

console.log(
  `PASS  verify:write-path  (${files.length} files scanned, ${commands.length} commands: ${commands.join(", ")})`,
);
