import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * One process-launch surface for every adapter.
 *
 * `Bun.spawn` was the original call and it is why the shipped application had
 * no working harness: `apps/desktop/make.sh` bundles the main process with
 * `--target=node`, Electron's main process is Node, and `Bun` is not a global
 * there. Every adapter path — probe, dispatch, cancel — threw
 * `Bun is not defined` in the packaged build while passing every test under
 * `bun test`. The runtime that runs the tests is not the runtime that ships.
 *
 * So this module speaks `node:child_process`, which both runtimes implement,
 * and no adapter names a runtime global again.
 */
export interface Launch {
  readonly argv: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Written to the child's stdin, which is then closed. */
  readonly input?: string | undefined;
}

/**
 * A launched process whose output is already being consumed.
 *
 * Draining starts at launch rather than after exit. A pipe holds 64 KB on
 * Windows and 64 KB on Linux; a harness that writes more than that before
 * anyone reads blocks forever on its own write, and the parent waits forever
 * for an exit that cannot arrive. Claude Code's JSON report carries the full
 * result text, so a long chapter reaches that limit as a matter of course.
 */
export interface Launched {
  readonly child: ChildProcess;
  /** Resolves with the exit code, or -1 when a signal ended the process. */
  readonly exited: Promise<number>;
  /** Everything the child wrote to stdout, complete once `exited` resolves. */
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  kill(): void;
}

const drain = (stream: NodeJS.ReadableStream | null): Promise<string> => {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.on("error", () => resolve(text));
    stream.on("end", () => resolve(text));
  });
};

/**
 * Is this program runnable, checked before spawning?
 *
 * `spawn` reports a missing binary asynchronously, through an `error` event
 * that arrives on a later tick. The Host needs a *synchronous* failure: a run
 * that never started must leave no workspace and no queue entry, and it can
 * only guarantee that if `dispatch` throws before it records anything. So the
 * PATH lookup happens here, in the one place that knows how the process is
 * started.
 */
const runnable = (program: string): boolean => {
  const ok = (path: string): boolean => {
    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (program.includes("/") || program.includes("\\") || isAbsolute(program)) return ok(program);

  // PATHEXT is why `claude` finds `claude.cmd` on Windows and nothing on Unix.
  const suffixes =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const suffix of suffixes) if (ok(join(dir, program + suffix))) return true;

  return false;
};

/**
 * Launch a process, or throw if it cannot start.
 *
 * Throwing synchronously for an absent binary is the contract the Host builds
 * on; see `runnable` for why the check cannot be left to the `error` event.
 */
export const launch = ({ argv, cwd, env, input }: Launch): Launched => {
  const [program, ...args] = argv;
  if (!program) throw new Error("launch needs a program");
  if (!runnable(program)) throw new Error(`cannot run ${program}: not found`);

  // A `.cmd` is a script, not an image Windows can execute. `runnable` finds
  // `claude.cmd` through PATHEXT and `shell: false` then hands it to libuv,
  // which answers ENOENT — so every harness installed by npm, which is all of
  // them on Windows, failed to start on the platform this ships to first. The
  // failure arrived as exit code -1, indistinguishable from a timeout.
  //
  // `cmd.exe /d /s /c` runs the script without a profile and without parsing
  // the arguments as a command line: the prompt stays author text.
  const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
  const [image, imageArgs] = script
    ? [process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", program, ...args]]
    : [program, args];

  const child = spawn(image, imageArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    // Never a shell: a prompt is author text and will contain quotes and
    // semicolons, none of which may become a command.
    shell: false,
    windowsHide: true,
    // Its own process group, so a cancel can signal the whole tree. A harness
    // is usually a launcher — `claude` is a script that execs node — and
    // signalling the single pid left the real worker running while the author
    // was told the run had stopped. Windows has no process groups; `taskkill
    // /t` covers the same ground there.
    detached: process.platform !== "win32",
  });

  const stdout = drain(child.stdout);
  const stderr = drain(child.stderr);

  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    // A binary that does not exist emits `error` and never `close`.
    child.on("error", () => settle(-1));
    child.on("close", (code, signal) => settle(code ?? (signal ? -1 : 0)));
  });

  // A harness that exits before reading its input leaves this pipe broken, and
  // an unhandled `error` on a Node stream is an uncaughtException — so a
  // harness rejecting its arguments took the whole main process down, and with
  // it the window and every unsaved manuscript in it. The write failing is
  // ordinary; `exited` already carries the outcome the caller acts on.
  child.stdin?.on("error", () => undefined);
  if (input !== undefined) child.stdin?.end(input);
  else child.stdin?.end();

  return {
    child,
    exited,
    stdout,
    stderr,
    kill: () => {
      // `kill` on Windows does not reach a process's children, and a CLI
      // harness is usually a launcher that spawns the real one. `taskkill /T`
      // is the only portable way to end the tree it started. SIGKILL follows
      // on Unix because a harness that traps SIGTERM would otherwise outlive
      // the cancel the author asked for.
      if (process.platform === "win32" && child.pid !== undefined) {
        const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        if (killed.error && child.exitCode === null) child.kill();
        return;
      }
      // Negative pid signals the group. It can fail if the group is already
      // gone, which is not an error worth surfacing during a cancel.
      const signal = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          child.kill(sig);
        }
      };
      signal("SIGTERM");
      const hard = setTimeout(() => signal("SIGKILL"), 800);
      hard.unref?.();
      void exited.then(() => clearTimeout(hard));
    },
  };
};

/** A timer that can be cleared, so a settled run leaves nothing pending. */
export const after = (ms: number): { promise: Promise<void>; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};
