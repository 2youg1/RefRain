import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "..", "dist");

/**
 * These read build output, so they run after `make.sh` rather than in the
 * default suite. `bun run gate` builds first; a bare `bun test` skips them
 * instead of failing on an absent dist/.
 */
const built = existsSync(join(dist, "main", "main.cjs"));
const whenBuilt = built ? describe : describe.skip;

test.failing("the default gate cannot skip every desktop test on a clean checkout", () => {
  const rootPackage = JSON.parse(
    readFileSync(join(here, "..", "..", "..", "package.json"), "utf8"),
  );

  expect(rootPackage.scripts.gate).toMatch(/build|desktop/);
});

test.failing("an Electron version change triggers the Windows IME gate", () => {
  const workflow = readFileSync(
    join(here, "..", "..", "..", ".github", "workflows", "ime-gate.yml"),
    "utf8",
  );

  expect(workflow).toContain("apps/desktop/package.json");
  expect(workflow).toContain("bun.lock");
});

test.failing("the no-network gate scans every process that the application starts", () => {
  const verifier = readFileSync(
    join(here, "..", "..", "..", "scripts", "verify-no-network.ts"),
    "utf8",
  );

  expect(verifier).toContain("packages/agent/src");
  expect(verifier).toContain("apps/desktop/src/main");
});

test("packaging uses Node platform names for the native binary", () => {
  const config = readFileSync(join(here, "..", "electron-builder.yml"), "utf8");

  expect(config).toMatch(/refrain-fs\.\$\{platform\}-\$\{arch\}\.node/);
  expect(config).not.toMatch(/refrain-fs\.\$\{os\}-\$\{arch\}\.node/);
});

test("one release job gathers every supported desktop build", () => {
  const workflow = readFileSync(
    join(here, "..", "..", "..", ".github", "workflows", "release.yml"),
    "utf8",
  );

  for (const target of ["windows-x64", "linux-x64", "mac-arm64", "mac-x64"])
    expect(workflow).toContain(`target: ${target}`);
  expect(workflow).toContain("needs: build");
  expect(workflow.match(/softprops\/action-gh-release/g)).toHaveLength(1);
});

/**
 * Build-shape checks. A packaged Electron app fails at launch for reasons no
 * unit test reaches: a CJS bundle under `"type": "module"`, an absolute asset
 * path that breaks under `file://`, a preload that resolves to nothing. Each of
 * those has one assertion here.
 */
whenBuilt("packaged build", () => {
  test("main and preload are emitted as CommonJS under .cjs", () => {
    expect(existsSync(join(dist, "main", "preload.cjs"))).toBe(true);
  });

  test("package.json main points at a file that exists", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    expect(existsSync(join(here, "..", pkg.main))).toBe(true);
  });

  test("main loads the preload path it actually ships", () => {
    const main = readFileSync(join(dist, "main", "main.cjs"), "utf8");
    expect(main).toContain("preload.cjs");
  });

  test("renderer assets are referenced relatively, so file:// resolves them", () => {
    const html = readFileSync(join(dist, "renderer", "index.html"), "utf8");
    const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)];

    expect(absolute).toHaveLength(0);
    expect(html).toContain("./assets/");
  });

  test("the renderer declares a Content-Security-Policy with no remote origin", () => {
    const html = readFileSync(join(dist, "renderer", "index.html"), "utf8");

    expect(html).toContain("Content-Security-Policy");
    expect(html).toMatch(/default-src\s+'self'/);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  test("the bundle carries no network client", () => {
    const bundle = readFileSync(join(dist, "main", "main.cjs"), "utf8");

    expect(bundle).not.toMatch(/\bnode:https?\b/);
    expect(bundle).not.toMatch(/\bXMLHttpRequest\b/);
  });

  test("no build-machine path is baked into the bundle", () => {
    const main = readFileSync(join(dist, "main", "main.cjs"), "utf8");

    // A bundler that inlines __dirname as a literal produces an app that looks
    // for its own files next to a directory only the build machine has.
    expect(main).not.toMatch(/["'](\/home\/|\/Users\/|[A-Z]:\\\\)[^"']*src[/\\]main["']/);
  });

  /**
   * Modules loaded by tests may not name Electron's runtime API at the top
   * level. Outside a real Electron process `electron` resolves to a CommonJS
   * stub that exports the binary's path, so `import { shell } from "electron"`
   * fails to parse and takes the whole suite with it. This is the third
   * variant of one mistake — after bun:sqlite and Bun.spawn — where the test
   * runtime and the shipping runtime disagree about what a module is.
   */
  test("modules the tests load do not name Electron's runtime API", () => {
    const main = join(here, "..", "src", "main");
    const ipc = readFileSync(join(main, "ipc.ts"), "utf8");
    const filesIpc = readFileSync(join(main, "files-ipc.ts"), "utf8");

    for (const [name, source] of [
      ["ipc.ts", ipc],
      ["files-ipc.ts", filesIpc],
    ] as const) {
      const offending = source
        .split("\n")
        .filter((line) => /^import\s+(?!type\b)[^;]*from\s+"electron";/.test(line));
      expect(offending, `${name} imports an Electron value at the top level`).toEqual([]);
    }
  });

  /**
   * SPEC Q8. The escape hatch must remain an escape hatch: a route to another
   * volume's trash, never a permanent delete dressed up as one. The Rust guard
   * enforces the absence of `fs::remove_*`; this asserts the other half — that
   * the interface can still tell the two failures apart.
   */
  test("a volume without a trash is a distinct code, not a sentence to parse", () => {
    const bindings = readFileSync(
      join(here, "..", "..", "..", "packages", "fs", "src", "bindings.rs"),
      "utf8",
    );

    // The outcome carries a code as well as a message. Regex over a human
    // sentence is not a contract, and branching on one silently stops working
    // the first time the wording changes.
    expect(bindings).toContain("NO_TRASH_HERE");
    expect(bindings).toMatch(/pub code: Option<String>/);

    const app = readFileSync(join(here, "..", "src", "renderer", "App.svelte"), "utf8");
    expect(app).toContain('outcome.code === "NO_TRASH_HERE"');
  });

  test("the renderer holds no privilege", () => {
    const main = readFileSync(join(dist, "main", "main.cjs"), "utf8");

    expect(main).toContain("contextIsolation");
    expect(main).toMatch(/nodeIntegration:\s*!1|nodeIntegration:\s*false/);
  });
});
