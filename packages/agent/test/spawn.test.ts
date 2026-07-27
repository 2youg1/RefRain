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

  /**
   * A harness may log forever. stdout and stderr used to append every chunk to
   * one string, so an accidental debug loop could consume the main process's
   * heap and take the window and every unsaved manuscript with it. The cap is
   * per stream: a useful result may still fit even when a noisy warning stream
   * does not.
   */
  test("a child cannot fill the main process heap with output", async () => {
    const noisy = script(
      "noisy.js",
      `const chunk = "x".repeat(1024 * 1024);
for (let i = 0; i < 10; i++) process.stdout.write(chunk);
`,
    );

    const run = launch({ argv: [process.execPath, noisy] });
    await run.exited;
    const output = await run.stdout;

    expect(Buffer.byteLength(output)).toBeLessThan(8 * 1024 * 1024 + 256);
    expect(output).toMatch(/REFRAIN_OUTPUT_TRUNCATED dropped=2097152 bytes/);
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

  /*
   * A harness used to inherit the whole environment. Whatever the author's
   * shell held went with it — API keys for services this application never
   * speaks to among them — and the request file embeds the manuscript, which is
   * untrusted text. One injected sentence and a credential is in a memo, and
   * memos travel into every later round.
   */
  test("a secret in this process's environment does not reach the child", async () => {
    const dump = script("env.js", "process.stdout.write(JSON.stringify(process.env));\n");
    process.env.REFRAIN_TEST_SECRET = "sk-do-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-neither-this";

    try {
      const run = launch({ argv: [process.execPath, dump] });
      await run.exited;
      const seen = JSON.parse(await run.stdout) as Record<string, string>;

      expect(seen.REFRAIN_TEST_SECRET).toBeUndefined();
      expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen.PATH).toBeDefined();
    } finally {
      delete process.env.REFRAIN_TEST_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("a credential the author configured for this harness does travel", async () => {
    const dump = script("env2.js", "process.stdout.write(JSON.stringify(process.env));\n");

    const run = launch({
      argv: [process.execPath, dump],
      env: { HARNESS_TOKEN: "configured-on-purpose" },
    });
    await run.exited;

    expect((JSON.parse(await run.stdout) as Record<string, string>).HARNESS_TOKEN).toBe(
      "configured-on-purpose",
    );
  });
});
