import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VIEWPORT_BLOCKS } from "../apps/native/src/generated/protocol.ts";
import {
  SHARED_FIXTURE_BLOCKS,
  SHARED_FIXTURE_BYTES,
  SHARED_FIXTURE_DOCUMENT,
} from "./native-document-fixture.ts";
import {
  nativeExecutablePath,
  processImagePath,
  processMemoryKiB,
  processWorkingDirectory,
  windowPlatformLabel,
} from "./native-runtime-process.ts";

const RUNS = 20;
/**
 * One 60Hz frame, and one number per platform below it where the platforms
 * genuinely differ. Input-to-present is a compositor claim, so it belongs to
 * the platform that composites — the same rule the project-performance budgets
 * follow.
 */
const INPUT_LATENCY_BUDGET_NS = 16_666_667;
const LONG_TASK_BUDGET_US = 50_000;
const MAX_RETAINED_WIDGETS = 260;
const FIXTURE_BLOCKS = SHARED_FIXTURE_BLOCKS;
const FIXTURE_BYTES = SHARED_FIXTURE_BYTES;
const INSERT_OFFSET = 360;
const TOP_PATTERN = `visible blocks 0–${DEFAULT_VIEWPORT_BLOCKS} of ${FIXTURE_BLOCKS}`;
const TAIL_PATTERN = `visible blocks ${FIXTURE_BLOCKS - DEFAULT_VIEWPORT_BLOCKS}–${FIXTURE_BLOCKS} of ${FIXTURE_BLOCKS}`;

const root = process.cwd();
const nativeDir = join(root, "apps/native");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
const snapshotPath = join(nativeDir, ".zig-cache/native-sdk-automation/snapshot.txt");
const screenshotPath = join(nativeDir, ".zig-cache/native-sdk-automation/screenshot-document.png");
const expectedExecutable = realpathSync(nativeExecutablePath(nativeDir));
// The face the binary actually embeds (`build.zig` maps `manuscript_font` to
// it). The old path named a file that is not in the build and is not even on
// disk, so the font evidence threw before it could prove anything.
const manuscriptFontPath = join(nativeDir, "fonts/NotoSansSC-Subset.ttf");
let publisherPid = 0;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function command(command: string, args: readonly string[], cwd: string): CommandResult {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function runNative(args: readonly string[]): string {
  const result = command(nativeCli, ["automate", ...args], nativeDir);
  if (result.status !== 0) {
    throw new Error(
      `native automate ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  const unexpectedStderr = result.stderr
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .filter(
      (line) =>
        !/^assert ok: \d+ pattern\(s\) (?:matched|absent) after \d+ms$/.test(line) &&
        // The delivery line prints a real path, and a real path is
        // backslashed on Windows — the POSIX-only shape read every Windows
        // delivery as unexpected stderr.
        !/^delivered [a-z-]+ -> .+[\\/]\.zig-cache[\\/]native-sdk-automation$/.test(line),
    );
  if (unexpectedStderr.length !== 0) {
    throw new Error(
      `native automate ${args.join(" ")} wrote unexpected stderr\n${unexpectedStderr.join("\n")}`,
    );
  }
  return result.stdout;
}

/**
 * Wait, without asking the OS for a `sleep` binary that only one of the two
 * platforms has — and without `Bun`, which the ScriptC lane this gate compiles
 * on does not provide. Every call site here waits one millisecond between
 * snapshot retries, so a spin is the whole cost, and it is a cost this loop
 * pays only while automation is not yet ready.
 */
function pause(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // spin
  }
}

function snapshot(): string {
  let lastCommandError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      runNative(["snapshot"]);
      lastCommandError = "";
    } catch (error: unknown) {
      lastCommandError = error instanceof Error ? error.message : String(error);
      pause(1);
      continue;
    }
    const text = readFileSync(snapshotPath, "utf8");
    if (
      text.includes("ready=true") &&
      text.includes("publisher_pid=") &&
      text.includes("gpu_input_latency_ns=") &&
      text.includes("canvas_frame_budget_ok=") &&
      text.includes("widget @w1/document#")
    ) {
      const observedPid = metric(text, "publisher_pid");
      if (publisherPid === 0) {
        publisherPid = observedPid;
        const observedExecutable = processImagePath(observedPid);
        // Null where the OS has no public channel for a process's working
        // directory (Windows keeps it in the PEB). The image path and the pid
        // still pin the identity; skipping is honest, inventing a value is not.
        const observedCwd = processWorkingDirectory(observedPid);
        if (observedExecutable !== expectedExecutable) {
          throw new Error(
            `automation publisher ${observedPid} runs ${observedExecutable}, expected ${expectedExecutable}`,
          );
        }
        if (observedCwd !== null && observedCwd !== realpathSync(nativeDir)) {
          throw new Error(
            `automation publisher ${observedPid} uses ${observedCwd}, expected ${nativeDir}`,
          );
        }
      } else if (observedPid !== publisherPid) {
        throw new Error(`automation publisher changed from ${publisherPid} to ${observedPid}`);
      }
      return text;
    }
    pause(1);
  }
  throw new Error(
    lastCommandError.length === 0
      ? "automation did not publish one complete diagnostic snapshot within 100 ms"
      : `automation snapshot stayed unavailable for 100 ms\n${lastCommandError}`,
  );
}

function requiredMatch(text: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = text.match(pattern);
  if (match === null) throw new Error(`snapshot does not contain ${label}`);
  return match;
}

function capturedNumber(text: string, pattern: RegExp, label: string): number {
  const match = requiredMatch(text, pattern, label);
  const value = match[1];
  if (value === undefined) throw new Error(`snapshot ${label} has no captured value`);
  return Number(value);
}

function metric(text: string, name: string): number {
  return capturedNumber(text, new RegExp(`${name}=([0-9]+)`), name);
}

function booleanMetric(text: string, name: string): boolean {
  const match = requiredMatch(text, new RegExp(`${name}=(true|false)`), name);
  return match[1] === "true";
}

interface Measurements {
  readonly samples: number[];
  budgetPasses: number;
  frameBudgetPasses: number;
  fullRepaints: number;
  maxDispatchErrors: number;
}

function measurements(): Measurements {
  return {
    samples: [],
    budgetPasses: 0,
    frameBudgetPasses: 0,
    fullRepaints: 0,
    maxDispatchErrors: 0,
  };
}

function recordMeasurement(snapshotText: string, measured: Measurements): void {
  measured.samples.push(metric(snapshotText, "gpu_input_latency_ns"));
  if (booleanMetric(snapshotText, "gpu_input_latency_budget_ok")) measured.budgetPasses += 1;
  if (booleanMetric(snapshotText, "canvas_frame_budget_ok")) measured.frameBudgetPasses += 1;
  if (booleanMetric(snapshotText, "canvas_frame_full_repaint")) measured.fullRepaints += 1;
  measured.maxDispatchErrors = Math.max(
    measured.maxDispatchErrors,
    metric(snapshotText, "dispatch_errors"),
  );
}

function widgetId(text: string, role: string, name: string): string {
  const match = requiredMatch(
    text,
    new RegExp(`widget @w1/document#([0-9]+) role=${role} name="${name}"`),
    `${name} widget`,
  );
  const id = match[1];
  if (id === undefined) throw new Error(`${name} widget has no id`);
  return id;
}

function widgetBounds(text: string, id: string, role: string, name: string): string {
  const match = requiredMatch(
    text,
    new RegExp(`widget @w1/document#${id} role=${role} name="${name}" bounds=\\(([^)]*)\\)`),
    `${name} bounds`,
  );
  const bounds = match[1];
  if (bounds === undefined) throw new Error(`${name} widget has no bounds`);
  return bounds;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("cannot calculate a percentile without samples");
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  const value = ordered[index];
  if (value === undefined) throw new Error("percentile index is outside the sample set");
  return value;
}

function average(values: readonly number[]): number {
  if (values.length === 0) throw new Error("cannot calculate an average without samples");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertPatterns(patterns: readonly string[]): void {
  runNative(["assert", "--timeout-ms", "30000", ...patterns]);
}

function residentMemory(snapshotText: string): {
  readonly rssKiB: number;
  readonly peakKiB: number;
} {
  return processMemoryKiB(metric(snapshotText, "publisher_pid"));
}

function latencyReport(measured: Measurements): {
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  readonly budget: number;
  readonly budgetPasses: number;
  readonly frameBudgetPasses: number;
  readonly fullRepaints: number;
  readonly maxDispatchErrors: number;
} {
  return {
    samples: measured.samples,
    p50: percentile(measured.samples, 0.5),
    p95: percentile(measured.samples, 0.95),
    max: Math.max(...measured.samples),
    mean: average(measured.samples),
    budget: INPUT_LATENCY_BUDGET_NS,
    budgetPasses: measured.budgetPasses,
    frameBudgetPasses: measured.frameBudgetPasses,
    fullRepaints: measured.fullRepaints,
    maxDispatchErrors: measured.maxDispatchErrors,
  };
}

// The product contract uses nearest-rank p95. Keep every miss in the report,
// but do not silently turn the stated percentile gate into a maximum gate.
function passesOneFrame(measured: Measurements): boolean {
  return (
    percentile(measured.samples, 0.95) <= INPUT_LATENCY_BUDGET_NS &&
    measured.frameBudgetPasses === measured.samples.length &&
    measured.fullRepaints === 0 &&
    measured.maxDispatchErrors === 0
  );
}

/**
 * Open the fixture the way an author opens a manuscript: adopt the project
 * folder (the automation channel answers only "which path"), then click the
 * document's row.
 *
 * No `go.2` first — the first-launch destination is already Files, and the
 * chord's second press is "close this destination" (`workbench.ts::navigate`),
 * so sending it here walked the rail shut and the adopt button vanished.
 *
 * The lane used to skip the whole sequence and set two environment variables no
 * reader has consumed since v0.2.5, so it measured an empty window — the
 * snapshot carried no manuscript textbox at all, and the run died looking for
 * one.
 */
function openTheFixture(): void {
  runNative(["wait"]);
  assertPatterns([`role=button name="打开一个项目文件夹"`]);
  runNative(["widget-click", "document", widgetId(snapshot(), "button", "打开一个项目文件夹")]);
  assertPatterns([`role=treeitem name="${SHARED_FIXTURE_DOCUMENT}"`]);
  runNative([
    "widget-click",
    "document",
    widgetId(snapshot(), "treeitem", SHARED_FIXTURE_DOCUMENT),
  ]);
  assertPatterns([`${FIXTURE_BLOCKS} blocks · ${FIXTURE_BYTES} bytes`]);
}

openTheFixture();
let current = snapshot();
const trackId = widgetId(current, "group", "RefRain manuscript track");
const editorId = widgetId(current, "textbox", "RefRain manuscript");
// Undo is a command, not a button: the surface prints its chord on the palette
// row and the menu, and `document.undo` is the same W1 path both take. The old
// script clicked a `name="Undo"` button that has not existed since the native
// surface landed.
const undo = (): string => runNative(["shortcut", "document.undo"]);
const manuscriptFont = readFileSync(manuscriptFontPath);
const nativeExecutable = readFileSync(expectedExecutable);
const initialFontEvidence = {
  sourceBytes: manuscriptFont.length,
  embeddedOffset: nativeExecutable.indexOf(manuscriptFont),
  gpuNonblank: booleanMetric(current, "gpu_nonblank"),
  canvasCommands: metric(current, "canvas_commands"),
};

runNative(["widget-wheel", "document", trackId, "-4000000"]);
assertPatterns([TOP_PATTERN]);
runNative(["profile", "on"]);

const scroll = measurements();
for (let index = 0; index < RUNS; index += 1) {
  const tail = index % 2 === 0;
  runNative(["widget-wheel", "document", trackId, tail ? "4000000" : "-4000000"]);
  assertPatterns([tail ? TAIL_PATTERN : TOP_PATTERN]);
  current = snapshot();
  recordMeasurement(current, scroll);
}

const focus = measurements();
for (let index = 0; index < RUNS; index += 1) {
  runNative(["widget-action", "document", trackId, "focus"]);
  runNative(["widget-action", "document", editorId, "focus"]);
  assertPatterns([`role=textbox name="RefRain manuscript".*focused=true`]);
  current = snapshot();
  recordMeasurement(current, focus);
}

const stableEditorBounds = widgetBounds(current, editorId, "textbox", "RefRain manuscript");
const topProjectionEnd = capturedNumber(
  current,
  /visible blocks 0–[0-9]+ of [0-9]+ · bytes 0–([0-9]+)/,
  "top projection end",
);
const compositionCommitBytes = 6;
runNative(["widget-action", "document", editorId, "set_selection", `0 ${FIXTURE_BYTES}`]);
assertPatterns([`selection=0..${topProjectionEnd}`, `selection 0\\.\\.${FIXTURE_BYTES}`]);
current = snapshot();
const crossParagraphSelection = {
  anchor: 0,
  focus: FIXTURE_BYTES,
  selectedBytes: FIXTURE_BYTES,
  firstVisibleBlock: 0,
  lastSelectedBlock: FIXTURE_BLOCKS - 1,
  projectedFocus: topProjectionEnd,
  snapshotObserved:
    current.includes(`selection=0..${topProjectionEnd}`) &&
    current.includes(`selection 0..${FIXTURE_BYTES}`),
};

runNative([
  "widget-action",
  "document",
  editorId,
  "set_selection",
  `${INSERT_OFFSET} ${INSERT_OFFSET}`,
]);
assertPatterns([`selection=${INSERT_OFFSET}..${INSERT_OFFSET}`]);
runNative(["widget-action", "document", editorId, "set_composition", "输入中"]);
assertPatterns([
  `selection=${INSERT_OFFSET + 9}..${INSERT_OFFSET + 9}`,
  `composition=${INSERT_OFFSET}..${INSERT_OFFSET + 9}`,
  TOP_PATTERN,
]);
current = snapshot();
if (widgetBounds(current, editorId, "textbox", "RefRain manuscript") !== stableEditorBounds) {
  throw new Error("collapsed preedit changed the editor bounds");
}

runNative(["widget-action", "document", editorId, "cancel_composition"]);
runNative(["assert", "--absent", "--timeout-ms", "30000", "composition="]);
assertPatterns([
  `${FIXTURE_BLOCKS} blocks · ${FIXTURE_BYTES} bytes`,
  `selection=${INSERT_OFFSET}..${INSERT_OFFSET}`,
]);
current = snapshot();
if (widgetBounds(current, editorId, "textbox", "RefRain manuscript") !== stableEditorBounds) {
  throw new Error("cancelling a collapsed preedit changed the editor bounds");
}

runNative(["widget-action", "document", editorId, "set_composition", "確定"]);
assertPatterns([
  `composition=${INSERT_OFFSET}..${INSERT_OFFSET + compositionCommitBytes}`,
  `selection=${INSERT_OFFSET + compositionCommitBytes}..${INSERT_OFFSET + compositionCommitBytes}`,
]);
current = snapshot();
if (widgetBounds(current, editorId, "textbox", "RefRain manuscript") !== stableEditorBounds) {
  throw new Error("committable collapsed preedit changed the editor bounds");
}
runNative(["widget-action", "document", editorId, "commit_composition"]);
runNative(["assert", "--absent", "--timeout-ms", "30000", "composition="]);
assertPatterns([
  `${FIXTURE_BYTES + compositionCommitBytes} bytes`,
  `selection=${INSERT_OFFSET + compositionCommitBytes}..${INSERT_OFFSET + compositionCommitBytes}`,
]);
undo();
assertPatterns([
  `${FIXTURE_BLOCKS} blocks · ${FIXTURE_BYTES} bytes`,
  `selection=${INSERT_OFFSET}..${INSERT_OFFSET}`,
]);

runNative([
  "widget-action",
  "document",
  editorId,
  "set_selection",
  `${INSERT_OFFSET} ${INSERT_OFFSET}`,
]);
assertPatterns([`selection=${INSERT_OFFSET}..${INSERT_OFFSET}`]);

const insert = measurements();
const insertUndo = measurements();
for (let index = 0; index < RUNS; index += 1) {
  runNative(["widget-action", "document", editorId, "focus"]);
  assertPatterns([`role=textbox name="RefRain manuscript".*focused=true`]);
  runNative(["widget-key", "document", "x", "x"]);
  assertPatterns([
    `${FIXTURE_BYTES + 1} bytes`,
    `selection=${INSERT_OFFSET + 1}..${INSERT_OFFSET + 1}`,
  ]);
  current = snapshot();
  recordMeasurement(current, insert);

  undo();
  assertPatterns([`${FIXTURE_BYTES} bytes`, `selection=${INSERT_OFFSET}..${INSERT_OFFSET}`]);
  current = snapshot();
  recordMeasurement(current, insertUndo);
}

const composition = measurements();
const cancel = measurements();
for (let index = 0; index < RUNS; index += 1) {
  runNative(["widget-action", "document", editorId, "focus"]);
  assertPatterns([`role=textbox name="RefRain manuscript".*focused=true`]);
  runNative(["widget-action", "document", editorId, "set_composition", "输入中"]);
  assertPatterns([
    `selection=${INSERT_OFFSET + 9}..${INSERT_OFFSET + 9}`,
    `composition=${INSERT_OFFSET}..${INSERT_OFFSET + 9}`,
  ]);
  current = snapshot();
  recordMeasurement(current, composition);

  runNative(["widget-action", "document", editorId, "cancel_composition"]);
  runNative(["assert", "--absent", "--timeout-ms", "30000", "composition="]);
  assertPatterns([`selection=${INSERT_OFFSET}..${INSERT_OFFSET}`]);
  current = snapshot();
  recordMeasurement(current, cancel);
}

const commit = measurements();
const compositionUndo = measurements();
for (let index = 0; index < RUNS; index += 1) {
  runNative(["widget-action", "document", editorId, "focus"]);
  assertPatterns([`role=textbox name="RefRain manuscript".*focused=true`]);
  runNative(["widget-action", "document", editorId, "set_composition", "確定"]);
  assertPatterns([
    `selection=${INSERT_OFFSET + 6}..${INSERT_OFFSET + 6}`,
    `composition=${INSERT_OFFSET}..${INSERT_OFFSET + 6}`,
  ]);

  runNative(["widget-action", "document", editorId, "commit_composition"]);
  runNative(["assert", "--absent", "--timeout-ms", "30000", "composition="]);
  assertPatterns([
    `${FIXTURE_BYTES + 6} bytes`,
    `selection=${INSERT_OFFSET + 6}..${INSERT_OFFSET + 6}`,
  ]);
  current = snapshot();
  recordMeasurement(current, commit);

  undo();
  assertPatterns([`${FIXTURE_BYTES} bytes`, `selection=${INSERT_OFFSET}..${INSERT_OFFSET}`]);
  current = snapshot();
  recordMeasurement(current, compositionUndo);
}

const profile = requiredMatch(current, /^frame_profile .*$/m, "frame profile")[0];
const stageMaximumsUs = {
  rebuild: metric(profile, "rebuild_max_us"),
  layout: metric(profile, "layout_max_us"),
  reconcile: metric(profile, "reconcile_max_us"),
  emit: metric(profile, "emit_max_us"),
  accessibility: metric(profile, "a11y_max_us"),
  plan: metric(profile, "plan_max_us"),
  present: metric(profile, "present_max_us"),
};
const maximumStageUs = Math.max(...Object.values(stageMaximumsUs));
const retainedWidgets = capturedNumber(
  current,
  /widget_nodes=([0-9]+)\/[0-9]+/,
  "retained widget count",
);
const memory = residentMemory(current);
runNative(["screenshot", "document"]);
const screenshotBytes = readFileSync(screenshotPath).length;
const observedPublisherPid = publisherPid;
if (observedPublisherPid === 0) throw new Error("automation publisher PID was not verified");
const allMeasurements = [
  scroll,
  focus,
  insert,
  insertUndo,
  composition,
  cancel,
  commit,
  compositionUndo,
];
const measuredActions = allMeasurements.reduce((sum, value) => sum + value.samples.length, 0);
const checks = {
  scrollP95: passesOneFrame(scroll),
  focusP95: passesOneFrame(focus),
  insertP95: passesOneFrame(insert),
  insertUndoP95: passesOneFrame(insertUndo),
  compositionP95: passesOneFrame(composition),
  cancelP95: passesOneFrame(cancel),
  commitP95: passesOneFrame(commit),
  compositionUndoP95: passesOneFrame(compositionUndo),
  noLongStage: maximumStageUs < LONG_TASK_BUDGET_US,
  boundedRetainedWidgets: retainedWidgets <= MAX_RETAINED_WIDGETS,
  crossParagraphSelection:
    crossParagraphSelection.snapshotObserved &&
    crossParagraphSelection.anchor === 0 &&
    crossParagraphSelection.focus === FIXTURE_BYTES &&
    crossParagraphSelection.selectedBytes === FIXTURE_BYTES,
  compositionGeometryStable: true,
  realFont:
    initialFontEvidence.sourceBytes > 0 &&
    initialFontEvidence.embeddedOffset >= 0 &&
    initialFontEvidence.gpuNonblank &&
    initialFontEvidence.canvasCommands > 0 &&
    screenshotBytes > 0,
  stablePublisherPid: true,
};

const report = {
  schemaVersion: 2,
  platform: windowPlatformLabel(process.env.DISPLAY),
  runsPerOperation: RUNS,
  fixture: {
    blocks: FIXTURE_BLOCKS,
    bytes: FIXTURE_BYTES,
    viewportBlocks: DEFAULT_VIEWPORT_BLOCKS,
  },
  scrollInputToPresentNs: latencyReport(scroll),
  focusToPresentNs: latencyReport(focus),
  insertTextInputToPresentNs: latencyReport(insert),
  insertUndoInputToPresentNs: latencyReport(insertUndo),
  compositionInputToPresentNs: latencyReport(composition),
  cancelInputToPresentNs: latencyReport(cancel),
  commitInputToPresentNs: latencyReport(commit),
  compositionUndoInputToPresentNs: latencyReport(compositionUndo),
  crossParagraphSelection,
  compositionGeometry: { stableBounds: stableEditorBounds },
  font: initialFontEvidence,
  screenshot: { path: screenshotPath, bytes: screenshotBytes },
  frameProfileUs: {
    intervalP50: metric(profile, "interval_p50_us"),
    intervalP90: metric(profile, "interval_p90_us"),
    stageMaximums: stageMaximumsUs,
  },
  retainedWidgets,
  rssKiB: memory.rssKiB,
  peakRssKiB: memory.peakKiB,
  measuredActions,
  publisherPid: observedPublisherPid,
  expectedExecutable,
  checks,
  passed: Object.values(checks).every((value) => value),
};

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exit(1);
