import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { auditNoNetwork } from "./no-network-policy.ts";

const roots: string[] = [];
const fixture = (source = "export const local = true;\n"): string => {
  const root = mkdtempSync(join(tmpdir(), "refrain-no-network-"));
  roots.push(root);
  const files: Record<string, string> = {
    "packages/core/src/probe.ts": source,
    "packages/fs/Cargo.toml": '[dependencies]\nserde = "1"\n',
    "apps/desktop/dist/main/main.cjs": "module.exports = {};\n",
    "apps/desktop/dist/main/preload.cjs": "module.exports = {};\n",
    "apps/desktop/dist/renderer/assets/index-safe.js": "const local = true;\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const manifest = {
    version: 1,
    files: Object.keys(files)
      .filter((path) => path.startsWith("apps/desktop/dist/"))
      .map((path) => ({ path: path.replace("apps/desktop/", ""), bytes: 1, sha256: "test" })),
  };
  const manifestPath = join(root, "apps/desktop/build/desktop-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return root;
};

const write = (root: string, relative: string, content: string): void => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the no-network invariant", () => {
  test("a complete local-only application passes source and built-byte inspection", async () => {
    const result = await auditNoNetwork(fixture());
    expect(result.problems).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.scannedBundles).toBe(3);
    expect(result.scannedSources).toBe(1);
  });

  test.each([
    ['await import("node:https")', "node network module"],
    ['import http2 from "node:http2"', "node network module"],
    ['const client = require("undici")', "network package"],
    ['globalThis.fetch("https://example.test")', "fetch()"],
  ])("source bypass %s is refused", async (source, what) => {
    const result = await auditNoNetwork(fixture(`${source};\n`));
    expect(result.violations.some((violation) => violation.what === what)).toBe(true);
    expect(result.violations[0]?.path).toBe("packages/core/src/probe.ts");
  });

  test("the production bundle is inspected rather than trusted from its sources", async () => {
    const root = fixture();
    write(
      root,
      "apps/desktop/dist/main/main.cjs",
      'const protocol = require("node:http2"); module.exports = protocol;\n',
    );
    const result = await auditNoNetwork(root);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "apps/desktop/dist/main/main.cjs",
        what: "node network module",
      }),
    );
  });

  test("the CLI exits nonzero and names a network capability in reviewed bytes", async () => {
    const root = fixture();
    write(root, "apps/desktop/dist/main/main.cjs", 'require("node:http2");\n');
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "verify-no-network.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("apps/desktop/dist/main/main.cjs:1  node network module");
  });

  test("comments do not manufacture a network capability", async () => {
    const result = await auditNoNetwork(
      fixture(
        'export const glyph = "😀"; // await import("node:https")\n/* globalThis.fetch("https://example.test") */\n',
      ),
    );
    expect(result.violations).toEqual([]);
  });

  test("every workflow audits network capability only after producing reviewed bytes", async () => {
    let invocations = 0;
    for (const name of ["gate.yml", "release.yml"]) {
      const source = await Bun.file(
        join(import.meta.dir, "..", ".github", "workflows", name),
      ).text();
      const workflow = parse(source) as {
        jobs?: Record<string, { steps?: { run?: unknown }[] }>;
      };
      for (const job of Object.values(workflow.jobs ?? {})) {
        const runs = (job.steps ?? []).flatMap((step) =>
          typeof step.run === "string" ? [step.run] : [],
        );
        const audit = runs.findIndex((run) => run.includes("verify:no-network"));
        if (audit < 0) continue;
        invocations += 1;
        const build = runs.findIndex((run) =>
          /build-desktop\.ts|build:desktop|\.\/make\.sh/.test(run),
        );
        expect(build).toBeGreaterThanOrEqual(0);
        expect(audit).toBeGreaterThan(build);
      }
    }
    expect(invocations).toBe(2);
  });

  test("a missing reviewed bundle cannot turn the guard into an empty success", async () => {
    const root = fixture();
    rmSync(join(root, "apps/desktop/dist/main/preload.cjs"));
    const result = await auditNoNetwork(root);
    expect(result.problems).toContain(
      "missing reviewed bundle: apps/desktop/dist/main/preload.cjs",
    );
    expect(result.scannedBundles).toBe(2);
  });
});
