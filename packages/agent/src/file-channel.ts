import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Capability, HarnessAdapter, ReviewTask, Run, SessionUsage } from "./types.ts";

/**
 * The L0 file channel (SPEC 6.1): the agent writes a Result Artifact to an
 * agreed path and the app watches disk. It requires nothing of a harness, so
 * it works with every one of them — including copy-paste into a web chat.
 *
 * This is the floor the compatibility promise rests on. A harness that cannot
 * be automated is degraded, never excluded.
 */
export class FileChannelAdapter implements HarnessAdapter {
  readonly id = "file";
  readonly tier = "L0" as const;

  constructor(private readonly root: string) {}

  async dispatch(run: Run, task: ReviewTask, _agent: Agent): Promise<void> {
    mkdirSync(run.workspace, { recursive: true });
    writeFileSync(run.requestPath, scaffold(task), "utf8");
  }

  async cancel(run: Run): Promise<void> {
    run.state = "cancelled";
  }

  /** A file drop reports nothing. Unknown is the honest answer, and never zero. */
  usage(): Capability<SessionUsage> {
    return { kind: "unknown" };
  }

  effectiveModel(): Capability<string> {
    return { kind: "unknown" };
  }

  workspaceFor(runId: string): string {
    return join(this.root, "runs", runId);
  }
}

/**
 * The app generates Before and Request; the agent fills only Agent reply.
 * Keeping the first two sections app-authored is what makes the artifact's
 * provenance checkable rather than merely claimed.
 */
export const scaffold = (task: ReviewTask): string =>
  [
    "# Before",
    "",
    ...task.editScopes.flatMap((scope) => [`<!-- scope ${scope.id} -->`, scope.text, ""]),
    "# Request",
    "",
    task.prompt,
    "",
    "# Agent reply",
    "",
    '<!-- Replace this comment with a single <agent-result version="1"> element. -->',
    "",
  ].join("\n");
