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
    if (run.state === "dispatched") run.state = "cancelled";
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
 * The reply contract, stated in the request itself.
 *
 * Measured against a parser with six shapes an agent might plausibly produce,
 * five failed: bare prose, a fenced code block, a polite preamble, a missing
 * version attribute, and a guessed element name. The first three are default
 * behaviour for most harnesses. Every one of those failures costs a full round
 * of tokens and tells the agent nothing about what went wrong, so the contract
 * travels with the request rather than living in a repository the agent has
 * never read.
 *
 * Spelled out rather than summarised: an agent cannot infer that prose outside
 * the root element is rejected, and it is exactly the kind of thing a model
 * adds to be helpful.
 */
const CONTRACT = `Reply with one <agent-result> element and nothing else — no
preamble, no closing remark, no code fence. Text outside the element is
rejected and the run fails.

<agent-result version="1">
  <replacement scope="SCOPE-ID">the rewritten text</replacement>
  <comments>
    <comment target="SCOPE-ID">an observation that changes nothing</comment>
  </comments>
  <memo topic="optional label">what you want to still know next time</memo>
</agent-result>

Rules:
- Use the scope ids marked in "# Before" above, exactly as written.
- One <replacement> per scope at most. Repeating a scope fails the run.
- An empty <replacement> deletes that scope's text.
- Every <comment> goes inside <comments>, and uses target= rather than scope=.
- Omit <replacement> entirely to propose no change; comments alone are valid
  and are how you raise a doubt without editing.
- You are writing a proposal, not the manuscript. A human reads every change
  and decides. Nothing you write reaches the text without that decision.

About <memo>: write it for whoever works on this next — possibly you after a
compaction, possibly a different agent. Record what you learned that is not
already visible in the text: the author's standing preferences, decisions
already settled, traps you found. Skip anything a reader could see by opening
the manuscript. It is optional, it is read by a human before it is reused, and
it is the only thing you carry across a lost context.`;

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
    "# Reply format",
    "",
    CONTRACT,
    "",
    "# Agent reply",
    "",
    "<!-- Your <agent-result> element replaces this comment. -->",
    "",
  ].join("\n");
