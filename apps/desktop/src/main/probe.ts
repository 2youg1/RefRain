import { after, type Launched, launch } from "@refrain/agent";

export type ProbeResult = { readonly ok: boolean; readonly detail?: string };

const TIMED_OUT = Symbol("probe timed out");

/**
 * Ask a harness whether it can start, without confusing failure with time.
 *
 * `-1` is what a child reports when a signal or spawn error ends it. The probe
 * also used `-1` as its timeout sentinel, so its first branch called both
 * "timed out after 4s" and the immediately following "cannot run" branch was
 * unreachable. A Symbol cannot collide with an operating-system exit status.
 *
 * The launcher is injectable because Bun and the shipped Node runtime disagree
 * on one edge: Bun throws ENOEXEC synchronously for an invalid executable,
 * while Node may report it through the child's error event. Testing the probe's
 * decision does not need to pretend those runtimes are the same.
 */
export const probeCommand = async (
  program: string,
  timeoutMs = 4_000,
  start: (program: string) => Launched = (command) => launch({ argv: [command, "--version"] }),
): Promise<ProbeResult> => {
  let child: Launched;
  try {
    child = start(program);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const timer = after(timeoutMs);
  const exited = await Promise.race([child.exited, timer.promise.then(() => TIMED_OUT)]);
  timer.cancel();

  if (exited === TIMED_OUT) {
    child.kill();
    return {
      ok: false,
      detail: `timed out after ${Math.max(1, Math.round(timeoutMs / 1_000))}s`,
    };
  }
  const code = typeof exited === "number" ? exited : -1;
  if (code === -1) return { ok: false, detail: `cannot run ${program}` };

  const version = (await child.stdout).trim().split("\n")[0];
  const failure = (await child.stderr).trim().split("\n")[0];
  return code === 0
    ? { ok: true, ...(version ? { detail: version } : {}) }
    : { ok: false, detail: failure || `exited ${code}` };
};
