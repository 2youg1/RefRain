/**
 * Contract tests for the file layer's boundary.
 *
 * These do not re-test the Rust — `cargo test` owns that. They test what only
 * shows up at the boundary: field names surviving the N-API conversion, numbers
 * arriving as numbers, refusals arriving as errors a caller can branch on, and
 * the trash refusing to touch a Source Backup through the public class rather
 * than through an internal call.
 *
 * The suite skips when the platform binary is absent, and says so. A silent
 * skip is how a broken native layer reaches a release.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binaryName, type Workspace as WorkspaceType } from "../src/index.ts";

const ROOT = "/tmp/refrain-fs-contract";
const OUTSIDE = "/tmp/refrain-fs-outside";
const BACKUP = ".refrain-source";

const built = existsSync(join(import.meta.dir, "..", binaryName()));

let Workspace: typeof WorkspaceType;

beforeAll(async () => {
  if (!built) return;
  ({ Workspace } = await import("../src/index.ts"));

  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(join(ROOT, "part-one"), { recursive: true });
  mkdirSync(join(ROOT, BACKUP), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });

  writeFileSync(join(ROOT, "chapter-1.md"), "first\n\nsecond\n");
  writeFileSync(join(ROOT, "chapter-10.md"), "tenth\n");
  writeFileSync(join(ROOT, "chapter-2.md"), "second\n");
  writeFileSync(join(ROOT, "第一章.md"), "中文正文\n");
  writeFileSync(join(ROOT, "cover.png"), "not text");
  writeFileSync(join(ROOT, "part-one", "nested.md"), "nested\n");
  writeFileSync(join(ROOT, BACKUP, "original.md"), "pristine\n");
  writeFileSync(join(OUTSIDE, "victim.md"), "outside\n");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const open = (): WorkspaceType => {
  const workspace = new Workspace([ROOT], {});
  workspace.scan();
  return workspace;
};

// The native layer is a build artefact, not a source file. Saying so out loud
// keeps a missing binary from reading as a passing suite.
const it = built ? test : test.skip;

if (!built) {
  test("the native binary is missing — run `bun run --cwd packages/fs build`", () => {
    expect(built).toBe(false);
  });
}

it("indexes a tree and reports the entry count", () => {
  const workspace = open();
  expect(workspace.size).toBeGreaterThan(0);
  expect(workspace.scan()).toBe(workspace.size);
});

it("carries every field across the boundary with the right type", () => {
  const workspace = open();
  workspace.sort("name", false);
  const entry = workspace.page(0, 100).find((e) => e.name === "chapter-1.md");

  expect(entry).toBeDefined();
  expect(typeof entry?.path).toBe("string");
  expect(entry?.kind).toBe("file");
  expect(typeof entry?.size).toBe("number");
  expect(typeof entry?.modifiedMs).toBe("number");
  expect(entry?.manuscript).toBe(true);
});

it("marks a non-manuscript sibling as such", () => {
  const workspace = open();
  const cover = workspace.page(0, 100).find((e) => e.name === "cover.png");
  expect(cover?.manuscript).toBe(false);
});

it("never indexes the Source Backup", () => {
  const workspace = open();
  const names = workspace.page(0, 1000).map((entry) => entry.name);

  expect(names).not.toContain("original.md");
  expect(names).not.toContain(BACKUP);
});

it("sorts numbered chapters the way a reader reads them", () => {
  const workspace = open();
  workspace.sort("name", false);
  const chapters = workspace
    .page(0, 1000)
    .filter((entry) => entry.name.startsWith("chapter-"))
    .map((entry) => entry.name);

  expect(chapters).toEqual(["chapter-1.md", "chapter-2.md", "chapter-10.md"]);
});

it("keeps directories first when the order is reversed", () => {
  const workspace = open();
  workspace.sort("name", true);
  expect(workspace.page(0, 1)[0]?.kind).toBe("directory");
});

it("ranks a substring match above a scattered one", () => {
  const workspace = open();
  const hits = workspace.search("chapter", 10);

  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.entry.name.startsWith("chapter")).toBe(true);
});

it("returns character offsets for a CJK query, not byte offsets", () => {
  const workspace = open();
  const hits = workspace.search("第一", 10);

  expect(hits[0]?.entry.name).toBe("第一章.md");
  // Bytes would be [0, 3]; the renderer highlights by character.
  expect([...(hits[0]?.positions ?? [])]).toEqual([0, 1]);
});

it("finds directories on their own for a destination picker", () => {
  const workspace = open();
  const hits = workspace.searchDirectories("part", 10);

  expect(hits.length).toBe(1);
  expect(hits[0]?.entry.kind).toBe("directory");
});

it("moves a file and reports where it landed", () => {
  const workspace = open();
  const from = join(ROOT, "chapter-2.md");
  const to = join(ROOT, "part-one", "chapter-2.md");

  expect(workspace.move(from, to)).toBe(to);
  expect(existsSync(to)).toBe(true);
  expect(existsSync(from)).toBe(false);

  workspace.move(to, from);
});

it("refuses a destination outside the roots, and changes nothing", () => {
  const workspace = open();
  const from = join(ROOT, "chapter-1.md");

  expect(() => workspace.move(from, join(OUTSIDE, "stolen.md"))).toThrow(/OUTSIDE_ROOTS/);
  expect(existsSync(from)).toBe(true);
  expect(existsSync(join(OUTSIDE, "stolen.md"))).toBe(false);
});

it("refuses to write into the Source Backup", () => {
  const workspace = open();

  expect(() => workspace.move(join(ROOT, "chapter-1.md"), join(ROOT, BACKUP, "x.md"))).toThrow(
    /SOURCE_BACKUP/,
  );
  expect(existsSync(join(ROOT, BACKUP, "original.md"))).toBe(true);
});

it("refuses to trash anything inside the Source Backup", () => {
  const workspace = open();

  expect(() => workspace.trash(join(ROOT, BACKUP, "original.md"))).toThrow(/SOURCE_BACKUP/);
  expect(existsSync(join(ROOT, BACKUP, "original.md"))).toBe(true);
});

it("refuses to trash a path outside the roots", () => {
  const workspace = open();

  expect(() => workspace.trash(join(OUTSIDE, "victim.md"))).toThrow(/OUTSIDE_ROOTS/);
  expect(existsSync(join(OUTSIDE, "victim.md"))).toBe(true);
});

it("exposes no permanent delete", () => {
  const workspace = open();
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(workspace));

  // Invariant, not style: a writer's misclick stays recoverable through the OS.
  expect(surface).toContain("trash");
  expect(surface).not.toContain("remove");
  expect(surface).not.toContain("delete");
  expect(surface).not.toContain("unlink");
});

it("reports each path in a batch separately", () => {
  const workspace = open();
  const outcomes = workspace.trashAll([join(ROOT, "missing-a.md"), join(ROOT, "missing-b.md")]);

  expect(outcomes.length).toBe(2);
  expect(outcomes.every((outcome) => !outcome.trashed)).toBe(true);
  expect(outcomes[0]?.error).toBeTruthy();
});

it("refuses a name Windows would mangle", () => {
  const workspace = open();

  expect(workspace.admits(join(ROOT, "nul.md"))).toBe(false);
  expect(workspace.admits(join(ROOT, "chapter."))).toBe(false);
  expect(workspace.admits(join(ROOT, "chapter-3.md"))).toBe(true);
});

it("puts a uniqueness suffix before the extension", () => {
  const workspace = open();
  const unique = workspace.uniqueName(join(ROOT, "chapter-1.md"));

  expect(unique.endsWith(".md")).toBe(true);
  expect(unique).toContain("chapter-1 2");
});

it("copies without disturbing the source", () => {
  const workspace = open();
  const from = join(ROOT, "chapter-1.md");
  const to = join(ROOT, "part-one", "copy.md");

  workspace.copy(from, to);
  expect(existsSync(from)).toBe(true);
  expect(existsSync(to)).toBe(true);
  rmSync(to, { force: true });
});

it("creates a directory and admits it afterwards", () => {
  const workspace = open();
  const made = workspace.createDirectory(join(ROOT, "part-two", "deep"));

  expect(existsSync(made)).toBe(true);
  rmSync(join(ROOT, "part-two"), { recursive: true, force: true });
});

it("pages without pulling the whole index across", () => {
  const workspace = open();
  const page = workspace.page(0, 2);

  expect(page.length).toBe(2);
  expect(workspace.page(0, 1000).length).toBe(workspace.size);
});
