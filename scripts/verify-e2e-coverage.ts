#!/usr/bin/env bun

export {};

const writing = await Bun.file("apps/desktop/e2e/writing-slice.ts").text();
const review = await Bun.file("apps/desktop/e2e/review-loop.ts").text();
const dispatch = await Bun.file("apps/desktop/e2e/dispatch-loop.ts").text();
const editorPerformance = await Bun.file("apps/desktop/e2e/editor-performance.ts").text();
const projectPerformance = await Bun.file(
  "crates/refrain-store/tests/project_performance.rs",
).text();
const largeInput = await Bun.file("crates/refrain-store/tests/large_input_performance.rs").text();
const logoGate = await Bun.file("scripts/verify-logo.ts").text();
const workflow = await Bun.file(".github/workflows/gate.yml").text();
const failures: string[] = [];

const requireFacts = (source: string, scope: string, facts: readonly string[]): void => {
  for (const fact of facts) {
    if (!source.includes(fact)) failures.push(`${scope} is missing: ${fact}`);
  }
};

requireFacts(writing, "Windows window/control E2E", [
  "/window/rect",
  'button[aria-label="最小化"]',
  'button[aria-label="最大化窗口"]',
  'pressKey("")',
  "keyboard Tab reaches the first custom window control",
  "正文尚未保存",
]);
requireFacts(writing, "Settings and installed-font E2E", [
  'invoke("list_fonts")',
  'clickButton("撤销本次调整")',
  'clickButton("恢复本页默认")',
  'pressKey("")',
]);
requireFacts(writing, "annotation and ticket E2E", [
  'clickButton("建立高亮")',
  'clickButton("添加批注")',
  'clickButton("将所选批注转为派发工单")',
  "annotations to project after restart",
]);
requireFacts(dispatch, "guided Harness E2E", [
  'candidate.candidateId === "kimi-code"',
  'clickButton("添加写作伙伴")',
  "the guided remove and disconnect leave Config empty",
]);
requireFacts(writing, "DisplayProfile E2E", [
  'invoke("display_profile")',
  "display.frameBudgetMs - 1000 / display.refreshHz",
  "display.hairlineCssPx * display.scaleFactor",
]);
requireFacts(editorPerformance, "100,000-block and Long Task gate", [
  "100_000",
  "repeatableLongTasks",
  "runs: RUNS",
]);
requireFacts(projectPerformance, "100,000-file gate", ["100_000", "warm_p95_us", "search_p95_us"]);
requireFacts(largeInput, "large-input gate", ["100_000", "100 * 1024 * 1024", "p95"]);
requireFacts(logoGate, "Logo pixel gate", ["[16, 24, 32, 64]", "getImageData"]);

for (const [surface, source, image] of [
  ["Welcome/Settings/Writing/Conflict", writing, 'screenshot("04-conflict")'],
  ["Review", review, 'screenshot("01-review")'],
  ["Dispatch/Connections", dispatch, 'screenshot("02-connections")'],
] as const) {
  if (!source.includes(image)) failures.push(`${surface} has no real-window screenshot checkpoint`);
}
requireFacts(workflow, "Windows evidence upload", [
  "refrain-windows-e2e-evidence",
  "target/e2e-evidence",
  "if: always() && runner.os == 'Windows'",
]);
for (const command of ["bun run e2e:app", "bun run e2e:review", "bun run e2e:dispatch"]) {
  if (!workflow.includes(command)) failures.push(`Windows CI does not run ${command}`);
}

if (failures.length > 0) {
  console.error("FAIL  verify:e2e-coverage");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:e2e-coverage  (8 Test §10 classes; Windows execution remains a P9 platform gate)",
);
