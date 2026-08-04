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
 * 允许把手稿字节落盘的函数。每一个都只在人类动作之后到达写者：
 *   refresh_open_view      作者在打字（`TextCommand::Editor` 之后的投影刷新）
 *   commit_decision_batch  作者的裁决，一次点击提交
 *   persist_in_entry       Save 的共享写者——作者自己的按键或按钮
 * `persist_in_entry` 列在这里是因为它**确实**是第三个写者，不是为了让门禁变绿：
 * 旧版那条按名字匹配的谓词从来没看见过它（`persist_` 不在动词表里）。
 */
const AUTHORISED = ["commit_decision_batch", "refresh_open_view", "persist_in_entry"] as const;

/*
 * Root 之外的唯一写路径：install_skill 把生成的协议写进 harness 的 skill 目录
 * （~/.kimi-code/skills/、~/.claude/skills/）。它只在作者点击时发生，永远不碰
 * 手稿字节，因此不属于本门的命题范围——记在这里是因为「Root 之外零写入」
 * 曾经是默认事实，从它开始不再是了。
 */

// 步骤 10 之后写路径不再经过一层命令函数：它就住在用例里。
// 扫 refrain-app 的生产源码（不含 tests/，那里的 commit 是夹具在造数据）。
const files = collect(["crates/refrain-app/src/**/*.rs"]);
if (files.length === 0) {
  console.error(
    "FAIL  verify:write-path: scanned 0 files — the scan is looking in the wrong place",
  );
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
 * 步骤 10 之前还有一层「命令函数调用共享写者」的间接，需要单独检查；
 * Native 之后没有那一层——写者就是用例本身，所以判据只剩一条：
 * **谁的函数体里出现了 `Project::commit`**。这比按名字猜更准，
 * 也正是旧版那条名字模式漏掉 `persist_revision` 的教训。
 */
const isAuthorised = (name: string): boolean =>
  AUTHORISED.includes(name as (typeof AUTHORISED)[number]);

const unexpected = writers.filter((writer) => !isAuthorised(writer.fn));

if (unexpected.length > 0) {
  console.error("FAIL  verify:write-path: an unauthorised path writes manuscript bytes");
  for (const writer of unexpected) console.error(`      ${writer.fn} commits in ${writer.file}`);
  console.error(`      authorised: ${AUTHORISED.join(", ")}`);
  process.exit(1);
}

console.log(
  `PASS  verify:write-path  (${files.length} files; ${writers.length} commit call(s), all behind ${AUTHORISED.join("/")})`,
);
