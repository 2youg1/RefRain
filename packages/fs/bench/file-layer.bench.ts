/**
 * Where the file layer's time actually goes.
 *
 * Run against a generated tree, so the numbers are reproducible on any machine
 * rather than dependent on one person's manuscript folder. Reported as p50 and
 * p95 over repeated runs: a single timing on a shared machine is noise, and a
 * threshold set from noise fails randomly in CI later.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "../src/index.ts";

const TREE = "/tmp/refrain-bench-tree";

const buildTree = (files: number, depth: number): void => {
  rmSync(TREE, { recursive: true, force: true });
  let created = 0;
  const perDirectory = Math.ceil(files / depth);

  for (let d = 0; d < depth; d += 1) {
    const directory = join(TREE, `part-${d}`);
    mkdirSync(directory, { recursive: true });
    for (let f = 0; f < perDirectory && created < files; f += 1) {
      // Chinese and English names in one tree: the matcher must handle both,
      // and a Latin-only benchmark would hide a per-character regression.
      const name = f % 3 === 0 ? `第${f}章-草稿.md` : `chapter-${f}-draft.md`;
      writeFileSync(join(directory, name), `paragraph ${f}\n\nsecond block\n`);
      created += 1;
    }
  }
};

const percentile = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

const measure = (label: string, runs: number, body: () => void): void => {
  // One untimed pass so the first run's page faults do not land in the sample.
  body();

  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    body();
    samples.push(performance.now() - started);
  }

  const p50 = percentile(samples, 0.5).toFixed(2);
  const p95 = percentile(samples, 0.95).toFixed(2);
  console.log(`${label.padEnd(38)} p50 ${p50.padStart(8)} ms   p95 ${p95.padStart(8)} ms`);
};

const FILES = Number(process.env.BENCH_FILES ?? 20_000);

console.log(`Building a tree of ${FILES} files...`);
buildTree(FILES, 40);

const workspace = new Workspace([TREE], {});
measure(`scan ${FILES} files`, 10, () => {
  workspace.scan();
});

console.log(`indexed ${workspace.size} entries\n`);

measure("sort by name (natural)", 20, () => workspace.sort("name", false));
measure("sort by modified", 20, () => workspace.sort("modified", true));
measure("search substring 'chapter-1'", 50, () => {
  workspace.search("chapter-1", 50);
});
measure("search subsequence 'cd'", 50, () => {
  workspace.search("cd", 50);
});
measure("search CJK '第1'", 50, () => {
  workspace.search("第1", 50);
});
measure("page(0, 200) for a virtual list", 100, () => {
  workspace.page(0, 200);
});

rmSync(TREE, { recursive: true, force: true });
