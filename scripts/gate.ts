#!/usr/bin/env bun
/** Run each selected gate without a pipe and preserve its exit status. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mapConcurrent, run } from "./command-pool.ts";
import { executableFor, TIER_A } from "./scriptc-tiers.ts";

/**
 * What a stage needs from the machine that runs it.
 *
 * This is the same idea `EVIDENCE_LANES` below already applies to evidence,
 * carried to every stage: a lane names one requirement, and a runner that
 * cannot meet it does not run the lane. The three values are the three CI jobs,
 * so a workflow says which one it is with `--needs` instead of listing stages.
 *
 * - `files` reads the repository, and compiles nothing but ScriptC.
 * - `cargo` needs a Rust toolchain.
 * - `native` needs the Native SDK toolchain. That is Zig **and** cargo:
 *   `apps/native/build.zig` runs `cargo build -p refrain-native-host --release`
 *   and links the staticlib into the test module, so `native test` is not a
 *   Zig-only command however much its name suggests otherwise.
 */
type Requirement = "files" | "cargo" | "native";

const REQUIREMENTS = ["files", "cargo", "native"] as const;

/**
 * The stages a data-layer assertion cannot make, grouped by what each one needs
 * from the machine that runs it.
 *
 * The grouping is the point: each lane names one requirement, so a runner that
 * cannot meet it does not run the lane and does not report a colour about it.
 * A lane that runs where its requirement is absent measures the runner, not the
 * product — and a red that everybody explains away is worse than no lane.
 *
 * - `pixels` needs a GPU view: the claim is about what reaches the screen.
 * - `data-performance` needs only a release build and a disk, thus any runner
 *   can produce it. The budgets are per platform, because NTFS and ext4 do not
 *   read metadata at the same speed.
 * - `window-performance` needs a real window on the release platform, and it
 *   drives it through the automation server. A shared runner has no such
 *   window.
 */
const EVIDENCE_LANES = ["pixels", "data-performance", "window-performance"] as const;

type EvidenceLane = (typeof EVIDENCE_LANES)[number];

interface Stage {
  readonly name: string;
  readonly argv: readonly string[];
  readonly needs: Requirement;
  /**
   * Set when a shared runner cannot judge the stage. An evidence stage never
   * enters the blocking run; `--evidence <lane>` is the only way to reach it.
   */
  readonly evidence?: EvidenceLane;
  /**
   * Set for a stage that writes files other stages read. It runs alone, before
   * everything else. `corpora` is the only writer in this table: it generates
   * `tests/corpora/*.md`, which `verify:roundtrip` reads and which Rust reads
   * with `include_bytes!` at compile time. A stage that starts writing must be
   * marked here, or it races the readers the moment the scans run in parallel.
   */
  readonly first?: true;
}

const stages: readonly Stage[] = [
  // Rust uses these generated corpora at compile time, so generate them first.
  { name: "corpora", argv: ["bun", "scripts/freeze-corpora.ts"], needs: "files", first: true },

  {
    name: "protocol:native",
    argv: ["bun", "scripts/generate-native-protocol.ts", "--check"],
    needs: "files",
  },
  { name: "fmt:check", argv: ["bun", "run", "fmt:check"], needs: "files" },

  // `check` and `test` are one npm script each for a person at a terminal, and
  // two different requirements for a machine. Split here rather than there: the
  // TypeScript halves need no toolchain, and a failure now names which half
  // broke instead of reporting that "check" did.
  { name: "check:ts", argv: ["bun", "run", "check:ts"], needs: "files" },
  { name: "check:native", argv: ["bun", "run", "check:native"], needs: "native" },
  { name: "test:ts", argv: ["bun", "test"], needs: "files" },
  { name: "test:native", argv: ["bun", "run", "test:native:null"], needs: "native" },

  {
    name: "verify:no-spec-upload",
    argv: ["bun", "scripts/verify-no-spec-upload.ts"],
    needs: "files",
  },
  { name: "verify:no-network", argv: ["bun", "scripts/verify-no-network.ts"], needs: "files" },
  { name: "verify:doc-state", argv: ["bun", "scripts/verify-doc-state.ts"], needs: "files" },
  {
    name: "verify:no-network-imports",
    argv: ["bun", "scripts/verify-no-network-imports.ts"],
    needs: "native",
  },
  { name: "verify:bridge", argv: ["bun", "scripts/verify-bridge.ts"], needs: "files" },
  {
    name: "verify:corner-authority",
    argv: ["bun", "scripts/verify-corner-authority.ts"],
    needs: "files",
  },
  {
    name: "verify:effect-territory",
    argv: ["bun", "scripts/verify-effect-territory.ts"],
    needs: "files",
  },
  {
    name: "verify:import-security",
    argv: ["bun", "scripts/verify-import-security.ts"],
    needs: "cargo",
  },
  { name: "verify:write-path", argv: ["bun", "scripts/verify-write-path.ts"], needs: "files" },
  { name: "verify:core-purity", argv: ["bun", "scripts/verify-core-purity.ts"], needs: "files" },
  {
    name: "verify:unsafe-surface",
    argv: ["bun", "scripts/verify-unsafe-surface.ts"],
    needs: "files",
  },
  { name: "verify:no-html-sink", argv: ["bun", "scripts/verify-no-html-sink.ts"], needs: "files" },
  {
    name: "verify:release-target",
    argv: ["bun", "scripts/verify-release-target.ts"],
    needs: "files",
  },
  { name: "verify:trash-only", argv: ["bun", "scripts/verify-trash-only.ts"], needs: "files" },
  { name: "verify:roundtrip", argv: ["bun", "scripts/verify-roundtrip.ts"], needs: "files" },

  // Wall-clock budgets. Each of these builds the release profile and judges a
  // timing, so each measures the machine as much as the product: two runs of
  // one binary on the author's own laptop read 89.3 ms and 80.5 ms for the same
  // code. On a shared runner the spread is wider and the verdict is noise. The
  // correctness half of both stays on the blocking path — `review.rs` and
  // `open_probe` are compiled and run in debug by `cargo test --workspace
  // --all-targets` — so what leaves here is the reading, not the coverage.
  {
    name: "verify:manuscript-scale",
    argv: ["bun", "scripts/verify-manuscript-scale.ts"],
    needs: "cargo",
    evidence: "data-performance",
  },
  {
    name: "verify:open-latency",
    argv: ["bun", "scripts/verify-open-latency.ts"],
    needs: "cargo",
    evidence: "data-performance",
  },
  {
    name: "verify:project-performance",
    argv: [
      "cargo",
      "test",
      "--release",
      "-p",
      "refrain-store",
      "--test",
      "project_performance",
      "--",
      "--nocapture",
    ],
    needs: "cargo",
    evidence: "data-performance",
  },
  {
    name: "verify:large-input-performance",
    argv: [
      "cargo",
      "test",
      "--release",
      "-p",
      "refrain-store",
      "--test",
      "large_input_performance",
      "--",
      "--nocapture",
    ],
    needs: "cargo",
    evidence: "data-performance",
  },
  {
    name: "verify:native-document-performance",
    argv: ["bun", "scripts/run-native-document-performance.ts"],
    needs: "native",
    evidence: "window-performance",
  },

  { name: "verify:docs-current", argv: ["bun", "scripts/verify-docs-current.ts"], needs: "cargo" },
  {
    name: "verify:themes-current",
    argv: ["bun", "scripts/verify-themes-current.ts"],
    needs: "files",
  },
  {
    name: "verify:font-coverage",
    argv: ["bun", "scripts/verify-font-coverage.ts"],
    needs: "files",
  },
  {
    name: "verify:command-space",
    argv: ["bun", "scripts/verify-command-space.ts"],
    needs: "files",
  },
  { name: "verify:chord-table", argv: ["bun", "scripts/verify-chord-table.ts"], needs: "files" },
  { name: "verify:wire-shapes", argv: ["bun", "scripts/verify-wire-shapes.ts"], needs: "cargo" },
  {
    name: "verify:native-theme-pixels",
    argv: ["bun", "scripts/verify-native-theme-pixels.ts"],
    needs: "native",
    evidence: "pixels",
  },
  {
    name: "verify:editor-kernel",
    argv: ["bun", "scripts/verify-editor-kernel.ts"],
    needs: "files",
  },
  { name: "verify:native-ime", argv: ["bun", "scripts/verify-native-ime.ts"], needs: "files" },
  {
    name: "verify:skill-doc-current",
    argv: ["bun", "scripts/verify-skill-doc-current.ts"],
    needs: "cargo",
  },
  {
    name: "verify:verification-order",
    argv: ["bun", "scripts/verify-verification-order.ts"],
    needs: "files",
  },
  { name: "verify:agent-entry", argv: ["bun", "scripts/verify-agent-entry.ts"], needs: "files" },
  {
    name: "verify:one-word-per-concept",
    argv: ["bun", "scripts/verify-one-word-per-concept.ts"],
    needs: "files",
  },
  {
    name: "verify:alternates-isolation",
    argv: ["bun", "scripts/verify-alternates-isolation.ts"],
    needs: "files",
  },
  {
    name: "verify:release-version",
    argv: ["bun", "scripts/verify-release-version.ts"],
    needs: "files",
  },
  {
    name: "verify:release-workflow",
    argv: ["bun", "scripts/verify-release-workflow.ts"],
    needs: "files",
  },
  {
    name: "verify:scriptc-coverage",
    argv: ["bun", "scripts/verify-scriptc-coverage.ts"],
    needs: "files",
  },
  { name: "verify:gates-run", argv: ["bun", "scripts/verify-gates-run.ts"], needs: "files" },
];

/** `--evidence <lane>[,<lane>…]`; without it the blocking gate runs. */
function requestedLanes(argv: readonly string[]): readonly EvidenceLane[] {
  const at = argv.indexOf("--evidence");
  if (at < 0) return [];
  const value = argv[at + 1];
  if (value === undefined) throw new Error(`--evidence needs a lane: ${EVIDENCE_LANES.join(", ")}`);
  return value.split(",").map((name) => {
    if (!EVIDENCE_LANES.includes(name as EvidenceLane)) {
      throw new Error(`unknown evidence lane ${name}; known: ${EVIDENCE_LANES.join(", ")}`);
    }
    return name as EvidenceLane;
  });
}

/** `--needs <requirement>`; without it every requirement runs. */
function requestedRequirement(argv: readonly string[]): Requirement | null {
  const at = argv.indexOf("--needs");
  if (at < 0) return null;
  const value = argv[at + 1];
  if (value === undefined) throw new Error(`--needs takes one of: ${REQUIREMENTS.join(", ")}`);
  if (!REQUIREMENTS.includes(value as Requirement)) {
    throw new Error(`unknown requirement ${value}; known: ${REQUIREMENTS.join(", ")}`);
  }
  return value as Requirement;
}

const lanes = requestedLanes(process.argv);
const requirement = requestedRequirement(process.argv);
const wanted = new Set<EvidenceLane>(lanes);
const selected = stages.filter((stage) => {
  if (lanes.length > 0) return stage.evidence !== undefined && wanted.has(stage.evidence);
  if (stage.evidence !== undefined) return false;
  return requirement === null || stage.needs === requirement;
});

/**
 * A tier A gate runs as its compiled executable, never as `bun scripts/*.ts`.
 *
 * A missing executable fails that gate rather than falling back to Bun: with a
 * fallback the compiled artefact was never the authority, and a ScriptC
 * regression would turn no gate red (roadmap D15). Run `bun run scriptc:build`
 * first — CI does.
 *
 * The substitution applies to the stage that runs the script itself. One stage
 * does not: `verify:native-document-performance` runs a launcher that opens a
 * real window and spawns the compiled verifier against it. Substituting the
 * verifier for the launcher ran the verifier with no window at all — it read
 * the snapshot the previous run left on the disk, asked the operating system
 * about a process that had exited, and reported a failure about a window that
 * nobody opened. The launcher spawns the same compiled program, thus D15 holds
 * where it means something.
 */
function compiledCommandFor(name: string, argv: readonly string[]): readonly string[] | null {
  const script = TIER_A[name];
  if (script === undefined) return null;
  return argv.includes(script) ? [executableFor(script)] : null;
}

interface Report {
  readonly name: string;
  readonly failed: boolean;
  readonly line: string;
  /** Empty when the stage streamed straight to the terminal. */
  readonly output: string;
}

/** The command a stage runs, or the reason it cannot run at all. */
type Plan =
  | { readonly kind: "run"; readonly argv: readonly string[] }
  | { readonly kind: "unrunnable"; readonly report: Report };

function planFor(stage: Stage): Plan {
  const compiled = compiledCommandFor(stage.name, stage.argv);
  const argv = compiled ?? stage.argv;
  const command = argv[0];
  if (command === undefined) throw new Error(`stage ${stage.name} has no command`);
  if (compiled !== null && !existsSync(command)) {
    return {
      kind: "unrunnable",
      report: {
        name: stage.name,
        failed: true,
        line: `FAIL  ${stage.name}  (tier A executable missing: ${command} — run scriptc:build)`,
        output: "",
      },
    };
  }
  return { kind: "run", argv };
}

function verdict(stage: Stage, status: number | null, started: number, output: string): Report {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failed = status !== 0;
  return {
    name: stage.name,
    failed,
    line: failed
      ? `FAIL  ${stage.name}  (${seconds}s, exit ${status ?? "signal"})`
      : `PASS  ${stage.name}  (${seconds}s)`,
    output,
  };
}

/** A stage that owns the terminal: its output streams as it is produced. */
function runStreaming(stage: Stage): Report {
  const plan = planFor(stage);
  if (plan.kind === "unrunnable") return plan.report;
  const [command, ...args] = plan.argv;
  if (command === undefined) throw new Error(`stage ${stage.name} has no command`);
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: "inherit" });
  return verdict(stage, result.status, started, "");
}

/** A stage that shares the machine: its output is captured and printed whole. */
async function runPooled(stage: Stage): Promise<Report> {
  const plan = planFor(stage);
  if (plan.kind === "unrunnable") return plan.report;
  const started = Date.now();
  const result = await run(plan.argv);
  return verdict(stage, result.status, started, result.output);
}

function publish(report: Report): void {
  // The whole of one stage's output, then its verdict line, as one block. The
  // block is what makes a parallel run readable, and it is what `gate.yml`'s
  // annotations depend on: they lift `^FAIL` and the first `^error:` out of the
  // log, which interleaved lines from sixteen stages would scramble.
  if (report.output !== "") process.stdout.write(report.output);
  console.log(report.line);
}

const failures: string[] = [];
const record = (report: Report): void => {
  publish(report);
  if (report.failed) failures.push(report.name);
};

// A writer runs alone and first: everything after it may read what it wrote.
for (const stage of selected.filter((candidate) => candidate.first === true)) {
  record(runStreaming(stage));
}

// The read-only scans share the machine. Everything else takes the same cargo
// target lock, so running those together turns into queueing with worse logs.
const rest = selected.filter((candidate) => candidate.first !== true);
for (const report of await mapConcurrent(
  rest.filter((stage) => stage.needs === "files"),
  runPooled,
)) {
  record(report);
}
for (const stage of rest.filter((candidate) => candidate.needs !== "files")) {
  record(runStreaming(stage));
}

const scope =
  lanes.length > 0
    ? `${lanes.join(" + ")} evidence`
    : `blocking${requirement === null ? "" : ` ${requirement}`}`;
console.log(`\nran ${selected.length} ${scope} stages, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
