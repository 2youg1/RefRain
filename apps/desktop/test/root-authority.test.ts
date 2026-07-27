import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RootAuthority } from "../src/main/root-authority.ts";

test("a main-issued Root permit survives restart and pins filesystem identity", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-"));
  const root = join(home, "work");
  const permits = join(home, "state", "roots.json");
  mkdirSync(root);
  try {
    const first = new RootAuthority(permits);
    expect(first.approve(root)).toBe(true);
    expect(first.status(root)).toBe("present");
    expect(new RootAuthority(permits).status(root)).toBe("present");

    rmSync(root, { recursive: true });
    mkdirSync(root);
    expect(new RootAuthority(permits).status(root)).toBe("denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an atomic save may replace a single-file Root without revoking it", () => {
  const parent = mkdtempSync(join(tmpdir(), "refrain-root-authority-file-"));
  const root = join(parent, "essay.md");
  const replacement = join(parent, "essay.md.writing");
  writeFileSync(root, "第一版。\n");
  try {
    const authority = new RootAuthority();
    expect(authority.approve(root)).toBe(true);
    writeFileSync(replacement, "第二版。\n");
    renameSync(replacement, root);
    expect(authority.status(root)).toBe("present");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Source Backup cannot mint a Root permit", () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-root-authority-backup-"));
  const backup = join(root, ".refrain-source");
  mkdirSync(backup);
  writeFileSync(join(backup, "01.md"), "原件。\n");
  try {
    const authority = new RootAuthority();
    expect(authority.approve(backup)).toBe(false);
    expect(authority.status(backup)).toBe("denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
