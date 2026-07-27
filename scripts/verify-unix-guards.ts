/**
 * Every Unix-only construct in the file layer is behind `cfg(unix)`.
 *
 * `packages/fs` compiles for Windows, which is the only platform 0.1.x
 * releases on, and the symlink tests are written against `std::os::unix`.
 * Four of them sat without a guard and broke the whole crate's Windows target
 * — invisibly here, because a Linux `cargo test` never asks the question.
 *
 * The real check is `cargo check --target x86_64-pc-windows-msvc`, which CI
 * runs on a Windows runner. This is the cheap one that runs everywhere: it
 * reads the source and asserts each `std::os::unix` use is preceded by a
 * `#[cfg(unix)]` inside the same item.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../packages/fs/src", import.meta.url));
const sources = readdirSync(SRC).filter((name) => name.endsWith(".rs"));

if (sources.length === 0) {
  console.error("FAIL  found no Rust sources — this gate scans by directory and has gone blind");
  process.exit(1);
}

/**
 * The guard for a use at `line` is the nearest `#[cfg(unix)]` above it that is
 * not separated by the end of an item. A blank line does not end an item, but
 * a line at zero indentation that closes a block does, so the search stops at
 * the enclosing `}` in column one.
 */
const guarded = (lines: readonly string[], at: number): boolean => {
  for (let i = at - 1; i >= 0 && at - i < 40; i -= 1) {
    const line = lines[i] ?? "";
    if (/#\[cfg\((any\()?unix/.test(line)) return true;
    if (/^\}/.test(line)) return false;
  }
  return false;
};

const unguarded: string[] = [];
let uses = 0;

for (const name of sources) {
  const lines = readFileSync(join(SRC, name), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!/\bstd::os::unix\b|\bos::unix::/.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    uses += 1;
    if (!guarded(lines, index)) unguarded.push(`${name}:${index + 1}  ${line.trim()}`);
  });
}

if (uses === 0) {
  console.error("FAIL  found no std::os::unix uses — the pattern this gate scans for has moved");
  process.exit(1);
}

if (unguarded.length > 0) {
  console.error(`FAIL  ${unguarded.length} Unix-only construct(s) reach the Windows target:`);
  for (const line of unguarded) console.error(`  ${line}`);
  console.error("      Put the item behind #[cfg(unix)]; Windows is the release platform.");
  process.exit(1);
}

console.log(`PASS  ${uses} Unix-only constructs across ${sources.length} sources are all guarded`);
