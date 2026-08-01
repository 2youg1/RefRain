#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

/*
 * The commands allowed to put manuscript bytes on disk. Each reaches the writer
 * only behind a human action:
 *   apply_editor_action    the author typing
 *   commit_decision_batch  the author's verdicts, committed by a click
 *   persist_revision       Save — the author's own keystroke or button
 * `persist_revision` is listed because it genuinely is a third writer, not to
 * make the gate pass: the old name-pattern predicate never saw it at all.
 */
const AUTHORISED = ["apply_editor_action", "commit_decision_batch", "persist_revision"] as const;

const files = collect(["apps/desktop/src-tauri/src/**/*.rs"]);
if (files.length === 0) {
  console.error(
    "FAIL  verify:write-path: scanned 0 files — the scan is looking in the wrong place",
  );
  process.exit(1);
}

// Every registered command, read from the source rather than from a list kept
// by hand: a list kept by hand is exactly what stops matching reality.
const commands: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  // 两种形态：`#[tauri::command]` 与 `#[tauri::command(async)]`。
  for (const match of text.matchAll(/#\[tauri::command(?:\(async\))?\][\s\S]{0,200}?fn\s+(\w+)/g)) {
    if (match[1] !== undefined) commands.push(match[1]);
  }
}

if (commands.length === 0) {
  console.error("FAIL  verify:write-path: found no registered commands — the pattern is stale");
  process.exit(1);
}

/*
 * The rule is "nothing else writes the manuscript", so the predicate must be
 * about reaching the writer — not about being named like one.
 *
 * The previous predicate was a name pattern
 * (`^(write|save|commit|...)_(chapter|document|...)`), a different proposition
 * from the one this file claims. The gap was not theoretical: `persist_revision`
 * (lib.rs -> persist_in_entry -> entry.store.commit) is a third manuscript
 * writer and the pattern never saw it, because `persist_` is not in the verb
 * list. `store_manuscript`, `update_document` and `flush_block` escape the same
 * way.
 *
 * Manuscript bytes reach disk through exactly one call, `Project::commit`
 * (`replace_file_atomically` is too broad: config, icons and material clones
 * use it too). So the gate asks a question it can answer exactly: which
 * functions contain that call, and is every one of them authorised?
 *
 * A call-graph walk was tried and withdrawn: `with_project` invokes a closure
 * parameter (`use_entry(self, entry)`), which a regex walk reads as a real edge,
 * and it then flagged three material commands that write nothing but their own
 * clone directory. A gate whose failures are mostly false hides the one true
 * positive among them.
 */

const COMMIT_CALL = /\.commit\(&DocumentCommit/g;

/** The function enclosing a byte offset, by scanning `fn` headers before it. */
const enclosing = (text: string, at: number): string => {
  let owner = "<top level>";
  for (const start of text.matchAll(/\bfn\s+(\w+)/g)) {
    const index = start.index ?? 0;
    if (index >= at) break;
    if (start[1] !== undefined) owner = start[1];
  }
  return owner;
};

/** Every function whose own body commits manuscript bytes. */
const writers: { file: string; fn: string }[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const hit of text.matchAll(COMMIT_CALL)) {
    writers.push({ file, fn: enclosing(text, hit.index ?? 0) });
  }
}

if (writers.length === 0) {
  console.error(
    "FAIL  verify:write-path: no call to Project::commit found — the writer moved and this gate is blind",
  );
  process.exit(1);
}

/*
 * `persist_in_entry` is the shared body behind Save. The command exposing it is
 * `persist_revision`; the check is that no other command calls it.
 */
const WRITER_FNS = ["persist_in_entry"] as const;
const isWriterFn = (name: string): boolean =>
  WRITER_FNS.includes(name as (typeof WRITER_FNS)[number]);
const isAuthorised = (name: string): boolean =>
  AUTHORISED.includes(name as (typeof AUTHORISED)[number]);

const strays: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const writer of WRITER_FNS) {
    for (const call of text.matchAll(new RegExp(`\\b${writer}\\s*\\(`, "g"))) {
      const owner = enclosing(text, call.index ?? 0);
      if (owner !== writer && !isAuthorised(owner) && commands.includes(owner)) {
        strays.push(owner);
      }
    }
  }
}

const unexpected = writers.filter((writer) => !isWriterFn(writer.fn) && !isAuthorised(writer.fn));

if (unexpected.length > 0 || strays.length > 0) {
  console.error("FAIL  verify:write-path: an unauthorised path writes manuscript bytes");
  for (const writer of unexpected) console.error(`      ${writer.fn} commits in ${writer.file}`);
  for (const stray of strays) console.error(`      command ${stray} calls the writer directly`);
  console.error(`      authorised commands: ${AUTHORISED.join(", ")}`);
  process.exit(1);
}

console.log(
  `PASS  verify:write-path  (${files.length} files, ${commands.length} commands; ${writers.length} commit call(s), all behind ${AUTHORISED.join("/")})`,
);
