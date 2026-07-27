import { expect, test } from "bun:test";
import { runsBunFile, runsBunScript, runsCommand, workflowRuns } from "./workflow-commands.ts";

const workflow = (run: string, comment = ""): string => `name: gate
${comment ? `# ${comment}\n` : ""}jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: ${JSON.stringify(run)}
`;

test("only workflow run bodies become executable evidence", () => {
  expect(workflowRuns(workflow("bun scripts/verify-real.ts", "verify-comment.ts"))).toEqual([
    "bun scripts/verify-real.ts",
  ]);
});

test("echoing a gate name is not invoking the gate", () => {
  const runs = workflowRuns(workflow("echo bun scripts/verify-grid.ts"));
  expect(runsBunFile(runs, "verify-grid.ts")).toBe(false);
  expect(runsBunScript(runs, "verify:grid")).toBe(false);
});

test("Bun files and package scripts require command position", () => {
  expect(runsBunFile(["bun apps/desktop/scripts/verify-grid.ts"], "verify-grid.ts")).toBe(true);
  expect(runsBunScript(["bun run verify:grid"], "verify:grid")).toBe(true);
  expect(runsBunFile(["printf verify-grid.ts"], "verify-grid.ts")).toBe(false);
});

test("named tools must be executable tokens", () => {
  expect(runsCommand(["bun x electron-builder --publish never"], "electron-builder")).toBe(true);
  expect(runsCommand(["cargo test --all-targets"], "cargo test")).toBe(true);
  expect(runsCommand(["echo cargo test"], "cargo test")).toBe(false);
});
