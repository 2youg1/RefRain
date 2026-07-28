/**
 * A file flushed to disk is opened for writing, even when nothing more is written.
 *
 * Windows refuses to flush a handle that carries no write access:
 * `FlushFileBuffers` on a read-only descriptor fails, and every durable state
 * write in the application goes through one of these. Unix allows it either
 * way, so the defect is invisible on the machine most of this was written on
 * and takes down the release platform — which is the only platform 0.1.x ships
 * to. Three of them shipped that way.
 *
 * Directories are the exception and are excluded: a directory cannot be opened
 * for writing at all, and both directory syncs already skip Windows, where the
 * guarantee they buy does not exist.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCES = ["packages/core/src/atomic-file.ts", "packages/agent/src/host-state.ts"];

const root = fileURLToPath(new URL("..", import.meta.url));

let flushes = 0;
const readOnly: string[] = [];

for (const relative of SOURCES) {
  const source = readFileSync(new URL(relative, `file://${root}`), "utf8");
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    if (!line.includes("fsyncSync(")) return;
    flushes += 1;

    // What was flushed, and how was it opened? The `openSync` that produced it
    // is the nearest one above, within the same small block.
    const name = line.match(/fsyncSync\((\w+)\)/)?.[1];
    if (name === undefined) return;
    if (name.toLowerCase().includes("director")) return; // excluded above

    for (let i = index - 1; i >= 0 && index - i < 8; i -= 1) {
      const candidate = lines[i] ?? "";
      if (!candidate.includes(`${name} = openSync(`)) continue;
      if (candidate.includes("O_RDONLY"))
        readOnly.push(`${relative}:${i + 1}  ${candidate.trim()}`);
      return;
    }
  });
}

if (flushes === 0) {
  console.error("FAIL  found no fsync calls — this gate scans by name and has gone blind");
  process.exit(1);
}

if (readOnly.length > 0) {
  console.error(`FAIL  ${readOnly.length} file flush(es) use a read-only descriptor:`);
  for (const line of readOnly) console.error(`  ${line}`);
  console.error("      Windows will not flush a handle without write access; use O_RDWR.");
  process.exit(1);
}

console.log(`PASS  ${flushes} flushes across ${SOURCES.length} sources hold a writable descriptor`);
