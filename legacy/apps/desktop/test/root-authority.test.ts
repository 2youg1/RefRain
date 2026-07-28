import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a permit persistence failure grants no in-memory authority", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-persist-failure-"));
  const root = join(home, "work");
  const blocked = join(home, "blocked");
  mkdirSync(root);
  writeFileSync(blocked, "not a directory");
  try {
    const authority = new RootAuthority(join(blocked, "roots.json"));
    expect(authority.approve(root)).toBe(false);
    expect(authority.holds(root)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a symlinked Root state directory cannot receive a permit marker", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-state-link-"));
  const root = join(home, "work");
  const outside = join(home, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, ".refrain"), process.platform === "win32" ? "junction" : "dir");
  try {
    const authority = new RootAuthority();
    expect(authority.approve(root)).toBe(false);
    expect(authority.holds(root)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
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

/**
 * SPEC Q25. Permission and filesystem identity are two questions asked at two
 * moments: an author who cleaned a drive and reopened RefRain met one warning
 * per vanished Root, for projects they never asked to open.
 */
test("holding a permit is answered without reading the disk", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-held-"));
  const root = join(home, "work");
  mkdirSync(root);
  try {
    const authority = new RootAuthority();
    expect(authority.approve(root)).toBe(true);

    rmSync(root, { recursive: true });
    expect(authority.holds(root)).toBe(true);
    expect(authority.status(root)).toBe("missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path that never had a permit is not held", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-unheld-"));
  try {
    expect(new RootAuthority().holds(join(home, "elsewhere"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Source Backup is refused even when a permit file claims it", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-root-authority-forged-"));
  const backup = join(home, "work", ".refrain-source");
  const permits = join(home, "state", "roots.json");
  mkdirSync(backup, { recursive: true });
  mkdirSync(join(home, "state"));
  writeFileSync(
    permits,
    JSON.stringify({
      version: 1,
      roots: [
        {
          path: backup,
          canonical: backup,
          kind: "folder",
          device: "1",
          inode: "2",
          birth: "3",
        },
      ],
    }),
  );
  try {
    const authority = new RootAuthority(permits);
    expect(authority.holds(backup)).toBe(false);
    expect(authority.status(backup)).toBe("denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
