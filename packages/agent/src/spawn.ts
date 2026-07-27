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

/**
 * One stream may use this much memory before the rest becomes a count.
 *
 * Eight MiB is enough for a harness to return several long chapters and their
 * diagnostics, while putting a hard ceiling under a debug loop. The old drain
 * appended forever; one noisy child could consume the main process heap and
 * take the window and every unsaved manuscript with it.
 */
const OUTPUT_LIMIT = 8 * 1024 * 1024;

const drain = (stream: NodeJS.ReadableStream | null): Promise<string> => {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve) => {
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let droppedBytes = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(kept, keptBytes).toString("utf8");
      resolve(
        droppedBytes === 0
          ? text
          : `${text}\n[REFRAIN_OUTPUT_TRUNCATED dropped=${droppedBytes} bytes]\n`,
      );
    };

    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = OUTPUT_LIMIT - keptBytes;
      if (room > 0) {
        const part = bytes.subarray(0, room);
        kept.push(part);
        keptBytes += part.length;
      }
      droppedBytes += Math.max(0, bytes.length - Math.max(0, room));
    });
    stream.on("error", finish);
    stream.on("end", finish);
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
/**
 * Resolved program paths, keyed by the name and the PATH that resolved it.
 *
 * A miss costs one `accessSync` per directory per extension, and Windows has
 * many of both — the search for a program that is not there walks the whole
 * product. The command-adapter suite launches dozens of children and started
 * timing out at five seconds each once Git's directories joined the PATH.
 * Within one process the answer cannot change unless the PATH does, which is
 * why the PATH is part of the key rather than assumed constant.
 */
const resolved = new Map<string, string | undefined>();

const resolveProgram = (program: string, environment: NodeJS.ProcessEnv): string | undefined => {
  const exists = (path: string): boolean => {
    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (program.includes("/") || program.includes("\\") || isAbsolute(program))
    return exists(program) ? program : undefined;

  // PATHEXT is why `claude` resolves to `claude.cmd` on Windows. Returning the
  // resolved path matters: libuv cannot execute the bare script name itself.
  //
  // Windows environment variable names are case-insensitive and arrive spelled
  // `Path`, so reading `environment.PATH` found nothing there and every harness
  // named without a directory — which is every harness an author configures by
  // name — was reported as not installed. `inherited` keeps the variable under
  // whatever case the platform used, so the lookup has to be case-insensitive
  // too.
  const fromEnvironment = (variable: string): string | undefined => {
    // Exact spelling first. Windows can carry both `Path` and `PATH` — a caller
    // that set one deliberately must get that one, and taking whichever key
    // enumerated first made the choice depend on insertion order.
    if (environment[variable] !== undefined) return environment[variable];
    const match = Object.keys(environment).find((key) => key.toUpperCase() === variable);
    return match === undefined ? undefined : environment[match];
  };

  const search = fromEnvironment("PATH") ?? "";
  const key = `${program}\u0000${search}`;
  if (resolved.has(key)) return resolved.get(key);

  const suffixes =
    process.platform === "win32"
      ? ["", ...(fromEnvironment("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];

  for (const dir of search.split(delimiter).filter(Boolean))
    for (const suffix of suffixes) {
      const candidate = join(dir, program + suffix);
      if (exists(candidate)) {
        resolved.set(key, candidate);
        return candidate;
      }
    }

  resolved.set(key, undefined);
  return undefined;
};

/**
 * The parts of this process's environment a harness needs, and no more.
 *
 * Everything used to be inherited, which handed each subprocess whatever the
 * author's shell happened to hold — API keys for services this application
 * never talks to among them. A harness needs to find its own files and speak
 * the author's language; it does not need the rest, and a prompt injected
 * through the manuscript could otherwise read a credential straight out of
 * `process.env`.
 *
 * A harness with its own credential is configured through `env` on the launch,
 * which is merged over this and stays explicit.
 */
const KEPT = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "USERNAME",
  "USER",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

const inherited = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => KEPT.has(name.toUpperCase())));

/**
 * Launch a process, or throw if it cannot start.
 *
 * Throwing synchronously for an absent binary is the contract the Host builds
 * on; see `resolveProgram` for why the check cannot be left to the `error` event.
 */
export const launch = ({ argv, cwd, env, input }: Launch): Launched => {
  const [program, ...args] = argv;
  if (!program) throw new Error("launch needs a program");
  const environment = { ...inherited(), ...env };
  const resolved = resolveProgram(program, environment);
  if (!resolved) throw new Error(`cannot run ${program}: not found`);

  // A `.cmd` is a script, not an image Windows can execute. Bare npm commands
  // therefore have to use the resolved PATHEXT path, not the name the author
  // entered. COMSPEC receives separate argv and no shell profile.
  const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  const [image, imageArgs] = script
    ? [environment.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", resolved, ...args]]
    : [resolved, args];

  const child = spawn(image, imageArgs, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    // Never ask Node to invent a shell command line. The one exception above is
    // an already-resolved Windows script, passed to COMSPEC as explicit argv.
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
