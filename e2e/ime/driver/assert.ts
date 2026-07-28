#!/usr/bin/env bun
/** Gate the run — exit 1 if any acceptance criterion is violated. */
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const p = `${ROOT}/results/summary.json`;
if (!existsSync(p)) {
  console.error("summary.json missing — run analyze.ts first");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>[];

let bad = 0;
for (const r of rows) {
  if (r.error) {
    console.error(`FAIL ${r.shell}: ${r.error}`);
    bad += 1;
    continue;
  }
  const checks: [string, boolean][] = [
    ["dropped words === 0", r.p2DroppedWords === 0],
    ["typing produced text", (r.p2Chars as number) > 0],
    [
      "punctuation first-press all ok",
      (r.punctTotal as number) > 0 && r.punctFirstPressOK === r.punctTotal,
    ],
    ["no stuck compositions", r.stuckComps === 0],
    ["no rendering stall > 1s", (r.rafMaxGapMs as number) < 1000],
    ["focused on first click", r.focusLatencyMs !== null],
  ];
  for (const [name, ok] of checks) {
    if (!ok) {
      console.error(`FAIL ${r.shell}: ${name}`);
      bad += 1;
    }
  }
}
if (bad) {
  console.error(`ime-gate: ${bad} violation(s)`);
  process.exit(1);
}
console.log(`ime-gate: all ${rows.length} shells pass`);
