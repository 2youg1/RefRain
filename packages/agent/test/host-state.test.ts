import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostStateDiagnostic } from "../src/host-state.ts";
import { readHostState, writeHostState } from "../src/host-state.ts";
import type { ReviewTask } from "../src/types.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-host-state-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const task = (id: string): ReviewTask => ({
  id,
  agentId: "agent-1",
  baseline: "revision-1",
  prompt: "Review this.",
  contextScope: [],
  editScopes: [{ id: `scope-${id}`, blockIds: [`block-${id}`], text: "Before." }],
});

describe("HostState recovery", () => {
  test("an invalid top-level shape is reported instead of posing as new state", () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(join(root, "host.json"), JSON.stringify([]), "utf8");

      expect(readHostState(root)).toEqual({
        version: 1,
        sequence: 0,
        queue: [],
        runs: [],
        drifted: [],
      });
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/HostState.*top-level/i));
    } finally {
      warnings.mockRestore();
    }
  });

  test("invalid JSON is reported instead of posing as new state", () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(join(root, "host.json"), '{"version":1', "utf8");

      expect(readHostState(root)).toEqual({
        version: 1,
        sequence: 0,
        queue: [],
        runs: [],
        drifted: [],
      });
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/HostState.*JSON/i));
    } finally {
      warnings.mockRestore();
    }
  });

  test("record diagnostics preserve the original bytes before a healthy write", () => {
    const serialized = JSON.stringify({
      version: 1,
      sequence: 0,
      queue: [task("good"), { ...task("bad"), prompt: 42 }],
      runs: [],
      drifted: [],
    });
    writeFileSync(join(root, "host.json"), serialized, "utf8");
    const diagnostics: HostStateDiagnostic[] = [];

    const state = readHostState(root, (diagnostic) => diagnostics.push(diagnostic));

    expect(state.queue.map((entry) => entry.id)).toEqual(["good"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      source: join(root, "host.json"),
      path: "$.queue[1]",
      reason: "invalid-record",
    });
    const evidence = diagnostics[0]?.evidencePath;
    expect(evidence).toBeString();
    expect(readFileSync(evidence!, "utf8")).toBe(serialized);

    writeHostState(root, state);
    expect(readFileSync(evidence!, "utf8")).toBe(serialized);
    expect(readFileSync(join(root, "host.json"), "utf8")).not.toBe(serialized);
  });

  test("a bad drift marker does not erase valid queued work", () => {
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        version: 1,
        sequence: 7,
        queue: [task("kept")],
        runs: [],
        drifted: ["scope-good", 42],
      }),
      "utf8",
    );
    const diagnostics: HostStateDiagnostic[] = [];

    const state = readHostState(root, (diagnostic) => diagnostics.push(diagnostic));

    expect(state.sequence).toBe(7);
    expect(state.queue.map((entry) => entry.id)).toEqual(["kept"]);
    expect(state.drifted).toEqual(["scope-good"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      source: join(root, "host.json"),
      path: "$.drifted[1]",
      reason: "invalid-record",
    });
  });

  test("an invalid sequence cannot reuse a surviving Run id", () => {
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        version: 1,
        sequence: "corrupt",
        queue: [],
        runs: [
          {
            id: "run7",
            state: "completed",
            task: task("sent"),
            comments: [],
            proposals: [],
          },
        ],
        drifted: [],
      }),
      "utf8",
    );
    const diagnostics: HostStateDiagnostic[] = [];

    const state = readHostState(root, (diagnostic) => diagnostics.push(diagnostic));

    expect(state.sequence).toBe(7);
    expect(state.runs.map((run) => run.id)).toEqual(["run7"]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        source: join(root, "host.json"),
        path: "$.sequence",
        reason: "invalid-record",
      }),
    );
  });

  test("duplicate identities and unsafe Run ids are isolated", () => {
    const storedRun = {
      id: "run2",
      state: "completed",
      task: task("sent"),
      comments: [],
      proposals: [],
    };
    const duplicatedScope = task("duplicated-scope").editScopes[0];
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        version: 1,
        sequence: 2,
        queue: [
          task("queued"),
          task("queued"),
          { ...task("duplicated-scope"), editScopes: [duplicatedScope, duplicatedScope] },
          { ...task("duplicated-context"), contextScope: ["chapter.md", "chapter.md"] },
        ],
        runs: [storedRun, storedRun, { ...storedRun, id: "run999999999999999999999" }],
        drifted: [],
      }),
      "utf8",
    );
    const diagnostics: HostStateDiagnostic[] = [];

    const state = readHostState(root, (diagnostic) => diagnostics.push(diagnostic));

    expect(state.queue.map((entry) => entry.id)).toEqual(["queued"]);
    expect(state.runs.map((run) => run.id)).toEqual(["run2"]);
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "$.queue[1]",
      "$.queue[2]",
      "$.queue[3]",
      "$.runs[1]",
      "$.runs[2]",
    ]);
  });

  test("a dispatched run cannot smuggle frozen proposals past artifact validation", () => {
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        version: 1,
        sequence: 1,
        queue: [],
        runs: [
          {
            id: "run1",
            state: "dispatched",
            task: task("sent"),
            comments: [],
            proposals: [
              {
                id: "p1",
                runId: "run1",
                baseline: "revision-1",
                scope: { id: "scope-sent", blockIds: ["block-sent"] },
                before: "Before.",
                after: "Unvalidated.",
              },
            ],
          },
        ],
        drifted: [],
      }),
      "utf8",
    );
    const diagnostics: HostStateDiagnostic[] = [];

    const state = readHostState(root, (diagnostic) => diagnostics.push(diagnostic));

    expect(state.runs).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ path: "$.runs[0]", reason: "invalid-record" });
  });

  test("a completed run must bind every frozen proposal to its own task", () => {
    writeFileSync(
      join(root, "host.json"),
      JSON.stringify({
        version: 1,
        sequence: 1,
        queue: [],
        runs: [
          {
            id: "run1",
            state: "completed",
            task: task("sent"),
            comments: [],
            proposals: [
              {
                id: "p1",
                runId: "some-other-run",
                baseline: "revision-1",
                scope: { id: "scope-sent", blockIds: ["block-sent"] },
                before: "Before.",
                after: "Unattributable.",
              },
            ],
          },
        ],
        drifted: [],
      }),
      "utf8",
    );

    expect(readHostState(root, () => undefined).runs).toEqual([]);
  });
});
