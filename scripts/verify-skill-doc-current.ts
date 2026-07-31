#!/usr/bin/env bun
/**
 * SKILL.md 必须与协议逐字一致。
 *
 * 这道门禁存在的理由是一次实测到的漂移：仓库里手写的 SKILL.md 教 agent 回
 * `version="1"`，而解析器要求 `"2"`——照着文档写的 agent **每一轮都会被拒**，
 * 而文档本身读起来毫无问题。它还完全没提 `<material-draft>`，那是协议里一个
 * 完整的元素。
 *
 * 这是「面向 agent 的文档」特有的失效形状：它整段遗漏或整句过时，而剩下的每
 * 一句仍然合法，任何「举例子」式的检查都取不到失败分支。读者是机器，照抄且
 * 无法自校。
 *
 * 所以这里不比对例子，比对**权威本身**：SKILL.md 必须逐字包含
 * `agent_protocol::skill_doc()` 的输出。转述一定会漂，而且转述读起来往往更顺。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Generate into a scratch file rather than /dev/stdout: bun's spawn gives the
// child a pipe, and writing to /dev/stdout through it fails with ENXIO. The
// first version of this gate did exactly that and was **permanently red**,
// which is as useless as a gate that can never fail — it just fails louder.
const scratch = mkdtempSync(join(tmpdir(), "refrain-skill-"));
const generatedPath = join(scratch, "SKILL.md");

const generated = spawnSync(
  "cargo",
  ["run", "--quiet", "-p", "refrain-core", "--example", "generate_skill_doc", "--", generatedPath],
  { encoding: "utf8" },
);

if (generated.status !== 0) {
  console.error("FAIL  verify:skill-doc-current: cannot generate the protocol document");
  console.error(generated.stderr.trim());
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const expected = await Bun.file(generatedPath).text();
rmSync(scratch, { recursive: true, force: true });

const committed = await Bun.file("SKILL.md")
  .text()
  .catch(() => null);

if (committed === null) {
  console.error("FAIL  verify:skill-doc-current: SKILL.md is missing from the repository");
  console.error("      run: cargo run -p refrain-core --example generate_skill_doc -- SKILL.md");
  process.exit(1);
}

if (committed.trim() !== expected.trim()) {
  console.error("FAIL  verify:skill-doc-current: SKILL.md has drifted from the protocol");
  console.error("      SKILL.md is generated, not written. Regenerate it:");
  console.error("      cargo run -p refrain-core --example generate_skill_doc -- SKILL.md");

  // Show where they part company: the first differing line is usually enough
  // to see whether the protocol moved or someone edited the document.
  const left = committed.trim().split("\n");
  const right = expected.trim().split("\n");
  for (let line = 0; line < Math.max(left.length, right.length); line += 1) {
    if (left[line] !== right[line]) {
      console.error(`      first difference at line ${line + 1}:`);
      console.error(`        committed: ${left[line] ?? "(end of file)"}`);
      console.error(`        protocol:  ${right[line] ?? "(end of file)"}`);
      break;
    }
  }
  process.exit(1);
}

console.log(
  `PASS  verify:skill-doc-current  (${expected.length} bytes, generated from skill_doc())`,
);
