import { describe, expect, test } from "bun:test";
import { commandCatalog, filterCommands } from "../src/shell/workbench-commands";

describe("workbench command catalog", () => {
  test("keeps the declared group order and caps an empty menu at nine", () => {
    const entries = filterCommands(commandCatalog({ hasProject: true, hasDocument: true }), "");
    const order = [
      "continue",
      "project",
      "work",
      "reference",
      "agents",
      "appearance",
      "application",
    ];

    expect(entries.length).toBeLessThanOrEqual(9);
    expect(entries.map((entry) => entry.id)).toContain("open-dispatch");
    expect(entries.map((entry) => order.indexOf(entry.group))).toEqual(
      [...entries].map((entry) => order.indexOf(entry.group)).sort((left, right) => left - right),
    );
  });

  test("searches Chinese, English, and stable command ids", () => {
    const entries = commandCatalog({ hasProject: true, hasDocument: true });

    expect(filterCommands(entries, "排版").map((entry) => entry.id)).toContain("open-typography");
    expect(filterCommands(entries, "typography").map((entry) => entry.id)).toContain(
      "open-typography",
    );
    expect(filterCommands(entries, "open-typ").map((entry) => entry.id)).toContain(
      "open-typography",
    );
  });

  test("keeps unavailable document actions visible with one concrete next step", () => {
    const entries = commandCatalog({ hasProject: true, hasDocument: false });
    const dispatch = entries.find((entry) => entry.id === "open-dispatch");

    expect(dispatch?.available).toBe(false);
    expect(dispatch?.nextStep).toBe("先打开一篇手稿");
  });
});
