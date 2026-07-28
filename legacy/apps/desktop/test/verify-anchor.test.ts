import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnchorMutation } from "../scripts/verify-anchor.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const built = existsSync(join(here, "..", "dist", "renderer", "index.html"));
const verifier = join(here, "..", "scripts", "verify-anchor.ts");
const whenBuilt = built ? describe : describe.skip;

if (!built && process.env.REFRAIN_REQUIRE_BUILT === "1")
  throw new Error("verify-anchor mutations require the reviewed renderer build");

const cases: ReadonlyArray<[AnchorMutation, string]> = [
  ["menu-input", "FAIL  missing command-menu input: selector nav.menu input matched no elements"],
  [
    "menu-opener",
    "FAIL  missing open-project command: selector nav.menu button.row matched no elements",
  ],
  ["chapter", "FAIL  missing chapter: selector nav .chapter matched no elements"],
  ["header", "FAIL  missing chapter header: selector header.bar matched no elements"],
  ["sheet", "FAIL  missing manuscript sheet: selector .sheet-surface matched no elements"],
];

whenBuilt("verify-anchor failure mutations", () => {
  for (const [mutation, message] of cases) {
    test(`removing ${mutation} makes the gate fail and release its resources`, async () => {
      const child = Bun.spawn([process.execPath, verifier, `--remove-target=${mutation}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(code).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain(message);
    }, 30_000);
  }
});
