import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("every production Text Head constructor delegates to the core authority", () => {
  const engine = source("../../../packages/core/src/text-engine.ts");
  const project = source("../../../packages/core/src/project.ts");
  const ipc = source("../src/main/ipc.ts");
  const fallbackStart = ipc.indexOf("const chapterHead");
  const fallbackEnd = ipc.indexOf("\n\nconst advanceChapter", fallbackStart);
  if (fallbackStart < 0 || fallbackEnd < 0) throw new Error("chapterHead source boundary moved");
  const fallback = ipc.slice(fallbackStart, fallbackEnd);

  expect(engine).not.toContain("nextHeadId");
  expect(engine.match(/id: newTextHeadId\(\)/g)).toHaveLength(2);
  expect(project).not.toContain("@load");
  expect(project).toContain("id: newTextHeadId()");
  expect(fallback).toContain("id: newTextHeadId()");
  expect(fallback).not.toContain("Date.now()");
  expect(ipc).toContain("newTextHeadId,");
});
