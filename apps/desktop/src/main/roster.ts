import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@refrain/agent";
import { replaceFileAtomically } from "@refrain/core";

/**
 * The agent roster, on disk.
 *
 * Everything else a workbench holds can be rebuilt: heads come from the
 * chapters, runs and their results are already files under `.refrain/runs/`,
 * proposals are frozen from those results. The roster cannot — an author who
 * configured four agents with four command templates had them evaporate when
 * the window closed, and no amount of reading the disk brings them back.
 *
 * `docs/project-layout.md` has named this file since before it existed. This is
 * the code catching up with the document rather than a new decision.
 */

/** What a saved agent looks like. The command template is the part that matters. */
interface StoredAgent {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  readonly model: string;
  readonly reasoningEffort: string;
  /**
   * Argv for a command harness, absent for the file channel.
   *
   * Stored beside the agent because without it a restored roster is a list of
   * names that cannot run: `agent:add` built the adapter from this and then
   * dropped it.
   */
  readonly template?: readonly string[];
  /** Set once the author has confirmed the argv; absent means never confirmed. */
  readonly trusted?: boolean;
}

export interface RosterEntry {
  readonly agent: Agent;
  readonly template?: readonly string[];
  /**
   * Whether the author has seen this command and agreed to run it.
   *
   * `agents.json` lives inside the project folder, so it arrives with whatever
   * the project arrived with — a clone, a shared drive, an archive from a
   * colleague. Restoring it used to register the command adapter outright, and
   * merely opening the Agents screen probed every agent, which runs the binary.
   * Opening someone else's writing project was enough to execute their choice
   * of program.
   *
   * A restored command is untrusted until the author reads the argv and says
   * yes. Trust is recorded per project, because it is a statement about this
   * project's file and not about the agent's name.
   */
  readonly trusted?: boolean;
}

const fileFor = (stateDir: string): string => join(stateDir, "agents.json");

/**
 * Read the roster, or an empty one.
 *
 * A corrupt or hand-edited file yields an empty roster rather than an
 * exception: the author can retype four agents, but they cannot start an
 * application that refuses to open their project.
 */
export const readRoster = (stateDir: string): RosterEntry[] => {
  const path = fileFor(stateDir);
  if (!existsSync(path)) return [];

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((raw): RosterEntry[] => {
      const entry = raw as Partial<StoredAgent>;
      // Identity and binding are the minimum; anything less is not an agent.
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.harness !== "string"
      )
        return [];

      const template =
        Array.isArray(entry.template) &&
        entry.template.length > 0 &&
        entry.template.every(
          (part): part is string => typeof part === "string" && !part.includes("\0"),
        )
          ? entry.template
          : undefined;
      if (entry.harness.startsWith("command:") && template === undefined) return [];

      return [
        {
          agent: {
            id: entry.id,
            name: entry.name,
            binding: {
              harness: entry.harness,
              model: typeof entry.model === "string" ? entry.model : "unspecified",
              reasoningEffort:
                typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "unspecified",
            },
          },
          ...(template === undefined ? {} : { template }),
          // Anything but a literal `true` reads as untrusted, so a hand-edited
          // or truncated file fails closed.
          trusted: entry.trusted === true,
        },
      ];
    });
  } catch {
    return [];
  }
};

/**
 * Write the roster through a temp file and rename.
 *
 * The same discipline as a chapter: a crash mid-write must not leave a
 * truncated roster, because the recovery from that is retyping every agent.
 */
export const writeRoster = (stateDir: string, entries: readonly RosterEntry[]): void => {
  const stored: StoredAgent[] = entries.map(({ agent, template, trusted }) => ({
    id: agent.id,
    name: agent.name,
    harness: agent.binding.harness,
    model: agent.binding.model,
    reasoningEffort: agent.binding.reasoningEffort,
    ...(template === undefined ? {} : { template }),
    ...(trusted === true ? { trusted: true } : {}),
  }));

  replaceFileAtomically(fileFor(stateDir), `${JSON.stringify(stored, null, 2)}\n`);
};
