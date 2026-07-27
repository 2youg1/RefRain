import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "../src/spawn.ts";

/**
 * The process boundary, tested against real children.
 *
 * `spawn.ts` had no tests of its own, which is how two crashes reached a
 * release: a broken stdin pipe killed the main process, and every npm-installed
 * harness failed to start on Windows. Both are properties of a real child
 * process — a stub cannot exhibit either — so these launch actual processes.
 */

const scratch = mkdtempSync(join(tmpdir(), "refrain-spawn-"));

const script = (name: string, body: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, body, "utf8");
  return path;
};

describe("launching a harness", () => {
  test("an absent binary is refused synchronously", () => {
    expect(() => launch({ argv: ["refrain-no-such-binary-anywhere"] })).toThrow(/not found/);
  });

  /*
   * The crash this file was written for.
   *
   * `child.stdin.end(input)` on a pipe whose reader has already gone emits
   * `error` on the stream, and an unhandled `error` on a Node stream is an
   * uncaughtException — not a rejected promise, not a return value. The report
   * that found this measured the main process dying with exit code 7.
   *
   * I could not reproduce that here, and say so rather than claim the listener
   * is proven. Under Bun 1.3 and under Node 24 the same sequence — child exits,
   * parent writes three megabytes — survives without any listener at all;
   * whatever swallows EPIPE on this machine is not present on the one that
   * crashed. So this test pins the behaviour that must hold (the launch resolves
   * with a number, nothing throws past it) rather than pretending to reproduce
   * a crash it never saw. The listener stays because an unhandled stream error
   * is a documented process-killer and one line is a cheap thing to be right
   * about.
   */
  test("a child that exits before reading its input does not take the process down", async () => {
    const quitter = script("quitter.js", "process.exit(0);\n");
    const large = "字".repeat(600_000);

    const run = launch({ argv: [process.execPath, quitter], input: large });
    const code = await run.exited;

    expect(typeof code).toBe("number");
  });

  test("input a child does read arrives intact", async () => {
    const echo = script(
      "echo.js",
      `let seen = "";
process.stdin.on("data", (chunk) => { seen += chunk; });
process.stdin.on("end", () => { process.stdout.write(seen.length + ""); });
`,
    );

    const run = launch({ argv: [process.execPath, echo], input: "甲乙丙" });
    await run.exited;

    expect(await run.stdout).toBe("3");
  });

  test("a non-zero exit is reported rather than thrown", async () => {
    const failing = script("failing.js", "process.exit(3);\n");

    const run = launch({ argv: [process.execPath, failing] });

    expect(await run.exited).toBe(3);
  });

  /*
   * `.cmd` is a script, not an executable image. `runnable` finds `claude.cmd`
   * through PATHEXT and `shell: false` hands it straight to libuv, which
   * answers ENOENT — so every harness npm installs, which is all of them on
   * Windows, could not start on the platform this ships to first.
   *
   * The repair routes scripts through COMSPEC. Asserting it on Linux would
   * assert nothing, so this states the rule and runs where it is true.
   */
  test.skipIf(process.platform !== "win32")("a .cmd shim launches", async () => {
    const shim = script("hello.cmd", "@echo off\r\necho 甲\r\n");

    const run = launch({ argv: [shim] });
    await run.exited;

    expect((await run.stdout).trim()).toBe("甲");
  });

  test("a prompt full of shell metacharacters stays one argument", async () => {
    const argv = script(
      "argv.js",
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    const dangerous = '"; rm -rf / #$(whoami)`echo x`';

    const run = launch({ argv: [process.execPath, argv, dangerous] });
    await run.exited;

    expect(JSON.parse(await run.stdout)).toEqual([dangerous]);
  });
});
