import { describe, expect, test } from "bun:test";
import type { EditorAction } from "@refrain/editor";
import { EditorActionQueue } from "../src/editor-host/editor-action-queue";

const replace = (text: string): EditorAction => ({
  baseRevision: "revision:1",
  changes: [{ kind: "replace", blocks: ["block:1"], text }],
});

describe("editor action queue", () => {
  test("input schedules one merged confirmation after the next frame", async () => {
    const frames: Array<() => void> = [];
    const applied: EditorAction[] = [];
    const queue = new EditorActionQueue(
      async (action) => {
        applied.push(action);
      },
      (task) => frames.push(task),
    );

    queue.submit(replace("first"));
    queue.submit(replace("current"));

    expect(applied).toEqual([]);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await queue.settled();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.changes[0]).toEqual({
      kind: "replace",
      blocks: ["block:1"],
      text: "current",
    });
  });

  test("actions that arrive while a confirmation is running wait for another frame", async () => {
    const frames: Array<() => void> = [];
    let release: (() => void) | null = null;
    const applied: string[] = [];
    const queue = new EditorActionQueue(
      async (action) => {
        applied.push(action.changes[0]?.kind === "replace" ? (action.changes[0].text ?? "") : "");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      (task) => frames.push(task),
    );

    queue.submit(replace("one"));
    frames.shift()?.();
    await Promise.resolve();
    queue.submit(replace("two"));
    expect(frames).toHaveLength(0);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await Promise.resolve();
    release?.();
    await queue.settled();
    expect(applied).toEqual(["one", "two"]);
  });
});
