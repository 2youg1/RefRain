import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "..", "dist");

/**
 * These read build output, so they run after `make.sh` rather than in the
 * default suite. `bun run gate` builds first; a bare `bun test` skips them
 * instead of failing on an absent dist/.
 */
const built = existsSync(join(dist, "main", "main.cjs"));
const whenBuilt = built ? describe : describe.skip;

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

  test("the renderer holds no privilege", () => {
    const main = readFileSync(join(dist, "main", "main.cjs"), "utf8");

    expect(main).toContain("contextIsolation");
    expect(main).toMatch(/nodeIntegration:\s*!1|nodeIntegration:\s*false/);
  });
});
