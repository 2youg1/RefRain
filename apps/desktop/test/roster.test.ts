import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@refrain/agent";
import { readRoster, writeRoster } from "../src/main/roster.ts";

/**
 * The roster is the only thing a workbench holds that the disk cannot rebuild.
 *
 * Heads come from the chapters, runs and their results are already files under
 * `.refrain/runs/`, proposals freeze from those results. But an author who
 * configured four agents with four command templates lost all of it when the
 * window closed, and nothing on disk could bring it back.
 *
 * The template is the part that catches people out: restoring names alone
 * yields a roster that cannot run, because `agent:add` built each adapter from
 * its template and then dropped it.
 */

const scratch = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "refrain-roster-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const agent = (id: string, name: string, harness: string): Agent => ({
  id,
  name,
  binding: { harness, model: "model", reasoningEffort: "default" },
});

describe("the agent roster survives a restart", () => {
  test("an agent and its command template both come back", () => {
    const { dir, cleanup } = scratch();
    try {
      writeRoster(dir, [
        { agent: agent("a1", "kimi", "command:kimi"), template: ["kimi", "--file", "{request}"] },
        { agent: agent("a2", "手工", "file") },
      ]);

      const restored = readRoster(dir);

      expect(restored).toHaveLength(2);
      expect(restored[0]?.agent.name).toBe("kimi");
      // Without this the roster is a list of names that fail on dispatch.
      expect(restored[0]?.template).toEqual(["kimi", "--file", "{request}"]);
      // The file channel has no command, and must not acquire a fabricated one.
      expect(restored[1]?.template).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a project file cannot persist permission to execute its command", () => {
    const { dir, cleanup } = scratch();
    try {
      const entry = {
        agent: agent("a1", "command", "command:a1"),
        template: ["command", "--version"],
        trusted: true,
      };
      writeRoster(dir, [entry]);
      const path = join(dir, "agents.json");
      const stored = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;

      expect(stored[0]?.trusted).toBeUndefined();
      stored[0] = { ...stored[0], trusted: true };
      writeFileSync(path, JSON.stringify(stored), "utf8");
      expect(readRoster(dir)[0]?.trusted).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an absent roster reads as empty rather than throwing", () => {
    const { dir, cleanup } = scratch();
    try {
      expect(readRoster(dir)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  /**
   * A hand-edited or truncated file must not stop the application opening. The
   * author can retype four agents; they cannot start a RefRain that refuses
   * their project.
   */
  test("a corrupt roster reads as empty rather than throwing", () => {
    const { dir, cleanup } = scratch();
    try {
      writeFileSync(join(dir, "agents.json"), "{ this is not json", "utf8");
      expect(readRoster(dir)).toEqual([]);

      writeFileSync(join(dir, "agents.json"), '{"not":"an array"}', "utf8");
      expect(readRoster(dir)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("an entry missing its identity is dropped, and the rest survive", () => {
    const { dir, cleanup } = scratch();
    try {
      writeFileSync(
        join(dir, "agents.json"),
        JSON.stringify([
          { name: "no id" },
          { id: "a2", name: "kept", harness: "file" },
          { id: "a3" },
        ]),
        "utf8",
      );

      const restored = readRoster(dir);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.agent.id).toBe("a2");
    } finally {
      cleanup();
    }
  });

  test("duplicate agent and command identities are isolated", () => {
    const { dir, cleanup } = scratch();
    try {
      writeFileSync(
        join(dir, "agents.json"),
        JSON.stringify([
          {
            id: "a1",
            name: "kept",
            harness: "command:h1",
            template: ["kept"],
          },
          { id: "a1", name: "duplicate id", harness: "file" },
          {
            id: "a2",
            name: "duplicate harness",
            harness: "command:h1",
            template: ["other"],
          },
        ]),
        "utf8",
      );

      expect(readRoster(dir).map((entry) => entry.agent.name)).toEqual(["kept"]);
    } finally {
      cleanup();
    }
  });

  test("the file is written where the layout document says it is", () => {
    const { dir, cleanup } = scratch();
    try {
      writeRoster(dir, [{ agent: agent("a1", "kimi", "command:kimi") }]);
      // docs/project-layout.md has named this path since before it existed.
      const raw = readFileSync(join(dir, "agents.json"), "utf8");
      expect(JSON.parse(raw)).toHaveLength(1);
      // Readable, because the document says an author may edit it.
      expect(raw).toContain("\n  ");
    } finally {
      cleanup();
    }
  });

  test("removing an agent leaves the rest on disk", () => {
    const { dir, cleanup } = scratch();
    try {
      const kept = { agent: agent("a1", "kept", "file") };
      const gone = { agent: agent("a2", "gone", "command:x"), template: ["x"] };
      writeRoster(dir, [kept, gone]);

      writeRoster(dir, [kept]);

      const restored = readRoster(dir);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.agent.id).toBe("a1");
    } finally {
      cleanup();
    }
  });
});
