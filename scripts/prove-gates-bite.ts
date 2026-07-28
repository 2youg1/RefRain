#!/usr/bin/env bun
/**
 * Proves each gate bites (SPEC 11.6).
 *
 * A gate that cannot fail is worse than no gate: it reads as coverage. So each
 * one is run against a repository carrying the exact defect it claims to catch,
 * and is required to exit non-zero and name the offence.
 *
 * Two failure modes this script defends against, both learned the hard way:
 *
 * 1. **The injection does not land.** An anchor that does not match rewrites
 *    nothing, the gate correctly passes, and the run reads as a dud gate. So
 *    every injection asserts its own anchor was found before the gate runs.
 * 2. **The restore does not restore.** A partial cleanup leaves the tree dirty
 *    and the next gate fails for an unrelated reason. Restore is in `finally`,
 *    and the byte content is compared against what was read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

interface Injection {
  readonly gate: string;
  readonly file: string;
  /** Absent for a created file; present for an edit to an existing one. */
  readonly anchor?: string;
  readonly replacement?: string;
  /** For a created file. */
  readonly content?: string;
  /** A fragment the failure output must contain, proving it named the offence. */
  readonly expect: string;
}

const INJECTIONS: readonly Injection[] = [
  {
    gate: "verify:no-network",
    file: "apps/desktop/src/shell/HealthProbe.vue",
    anchor: "const report = ref<HealthReport | null>(null);",
    replacement:
      'const report = ref<HealthReport | null>(null);\nawait fetch("https://example.com/telemetry");',
    expect: "HealthProbe.vue",
  },
  {
    gate: "verify:bridge",
    file: "apps/desktop/src/shell/HealthProbe.vue",
    anchor: "const report = ref<HealthReport | null>(null);",
    replacement:
      'const report = ref<HealthReport | null>(null);\nconst raw = invoke("health", {});',
    expect: "HealthProbe.vue",
  },
  {
    gate: "verify:core-purity",
    file: "crates/refrain-core/src/health.rs",
    anchor: "use serde::{Deserialize, Serialize};",
    replacement: "use serde::{Deserialize, Serialize};\nuse std::fs;",
    expect: "health.rs",
  },
  {
    gate: "verify:trash-only",
    file: "crates/refrain-store/src/schema.rs",
    anchor: "pub fn open_in_memory() -> rusqlite::Result<Connection> {",
    replacement:
      "pub fn scrub(path: &str) {\n    std::fs::remove_file(path).ok();\n}\n\npub fn open_in_memory() -> rusqlite::Result<Connection> {",
    expect: "schema.rs",
  },
  {
    gate: "verify:write-path",
    file: "apps/desktop/src-tauri/src/lib.rs",
    anchor: "/// The single command registry.",
    replacement:
      "#[tauri::command]\n#[specta::specta]\nfn save_chapter(_text: String) {}\n\n/// The single command registry.",
    expect: "save_chapter",
  },
  {
    gate: "verify:roundtrip",
    file: "tests/corpora/ideographic-indent.md",
    anchor: "　　全角空格缩进的段落，中文写作常用。",
    replacement: "　　全角空格缩进的段落，中文写作常用。 ",
    expect: "ideographic-indent.md",
  },
  {
    gate: "verify:no-js",
    file: "scripts/injected-helper.js",
    content: "export const helper = () => 1;\n",
    expect: "injected-helper.js",
  },
  {
    gate: "verify:gates-run",
    file: "scripts/verify-injected-orphan.ts",
    content: "// A gate nothing invokes.\nconsole.log('PASS');\n",
    expect: "verify-injected-orphan.ts",
  },
];

const script = (gate: string) => `scripts/${gate.replace("verify:", "verify-")}.ts`;

let proved = 0;
const problems: string[] = [];

for (const injection of INJECTIONS) {
  const created = injection.content !== undefined;
  const original = created ? null : readFileSync(injection.file, "utf8");

  try {
    if (created) {
      writeFileSync(injection.file, injection.content ?? "");
    } else {
      if (injection.anchor === undefined || injection.replacement === undefined) {
        throw new Error(`${injection.gate}: an edit needs both an anchor and a replacement`);
      }
      // The injection must land. A silent no-op would make a working gate look
      // like a dud, which is the reverse misreading and just as expensive.
      if (!original?.includes(injection.anchor)) {
        throw new Error(`${injection.gate}: ANCHOR MISSING in ${injection.file}`);
      }
      writeFileSync(injection.file, original.replace(injection.anchor, injection.replacement));
    }

    const result = spawnSync("bun", [script(injection.gate)], { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;

    if (result.status === 0) {
      problems.push(`${injection.gate}: passed with its defect injected — the gate does not bite`);
    } else if (!output.includes(injection.expect)) {
      problems.push(
        `${injection.gate}: failed but never named "${injection.expect}" — the diagnostic is useless`,
      );
    } else {
      console.log(`BITES  ${injection.gate}  (exit ${result.status}, named ${injection.expect})`);
      proved += 1;
    }
  } finally {
    if (created) {
      rmSync(injection.file, { force: true });
    } else if (original !== null) {
      writeFileSync(injection.file, original);
    }
  }
}

// Everything must be back the way it was, or the next run measures a different
// repository than the one this one claims to have tested.
for (const injection of INJECTIONS) {
  if (injection.content !== undefined && existsSync(injection.file)) {
    problems.push(`${injection.gate}: injected file ${injection.file} was not removed`);
  }
}

const restored = spawnSync(
  "git",
  ["status", "--porcelain", "--", ...INJECTIONS.map((i) => i.file)],
  {
    encoding: "utf8",
  },
);
if (restored.stdout.trim() !== "") {
  problems.push(`the tree was left dirty:\n${restored.stdout.trim()}`);
}

console.log(`\nproved ${proved}/${INJECTIONS.length} gates bite`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  process.exit(1);
}
