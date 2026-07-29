import { describe, expect, test } from "bun:test";
import { reduceSurface, type WorkbenchSurface } from "../src/shell/workbench-surface";

const writing: WorkbenchSurface = { kind: "writing" };

describe("workbench surface", () => {
  test("opening one surface replaces the previous surface", () => {
    const settings = reduceSurface(writing, { kind: "open", target: "settings" }, false);
    const connections = reduceSurface(settings, { kind: "open", target: "connections" }, false);

    expect(connections).toEqual({ kind: "connections" });
  });

  test("opening the current surface returns to writing", () => {
    const settings: WorkbenchSurface = { kind: "settings" };
    expect(reduceSurface(settings, { kind: "open", target: "settings" }, true)).toEqual(writing);
  });

  test("review and dispatch require an active document", () => {
    expect(reduceSurface(writing, { kind: "open", target: "review" }, false)).toEqual(writing);
    expect(reduceSurface(writing, { kind: "open", target: "dispatch" }, false)).toEqual(writing);
  });

  test("return and document selection always restore writing", () => {
    const review: WorkbenchSurface = { kind: "review" };
    expect(reduceSurface(review, { kind: "return" }, true)).toEqual(writing);
    expect(reduceSurface(review, { kind: "documentSelected" }, true)).toEqual(writing);
  });
});
