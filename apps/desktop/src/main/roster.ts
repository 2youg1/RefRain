import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@refrain/agent";
import { replaceStateFileAtomically } from "@refrain/core";

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
}

export interface RosterEntry {
  readonly agent: Agent;
  readonly template?: readonly string[];
  /**
   * Whether the author has confirmed the command during this application
   * session. It is deliberately absent from the stored roster: a project file
   * cannot authorize the command it asks RefRain to execute.
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

    const seenIds = new Set<string>();
    const seenHarnesses = new Set<string>();
    return parsed.flatMap((raw): RosterEntry[] => {
      const entry = raw as Partial<StoredAgent>;
      // Identity and binding are the minimum; anything less is not an agent.
      if (
        typeof entry.id !== "string" ||
        entry.id.trim().length === 0 ||
        typeof entry.name !== "string" ||
        entry.name.trim().length === 0 ||
        typeof entry.harness !== "string"
      )
        return [];

      const commandHarness = entry.harness.startsWith("command:") && entry.harness.length > 8;
      if (entry.harness !== "file" && !commandHarness) return [];
      const template =
        Array.isArray(entry.template) &&
        entry.template.length > 0 &&
        typeof entry.template[0] === "string" &&
        entry.template[0].trim().length > 0 &&
        entry.template.every(
          (part): part is string => typeof part === "string" && !part.includes("\0"),
        )
          ? entry.template
          : undefined;
      if (commandHarness && template === undefined) return [];
      if (seenIds.has(entry.id) || (entry.harness !== "file" && seenHarnesses.has(entry.harness)))
        return [];
      seenIds.add(entry.id);
      if (entry.harness !== "file") seenHarnesses.add(entry.harness);

      return [
        {
          agent: {
            id: entry.id,
            name: entry.name,
            binding: {
              harness: entry.harness,
              model:
                typeof entry.model === "string" && entry.model.trim().length > 0
                  ? entry.model
                  : "unknown",
              reasoningEffort:
                typeof entry.reasoningEffort === "string" && entry.reasoningEffort.trim().length > 0
                  ? entry.reasoningEffort
                  : "unknown",
            },
          },
          ...(template === undefined ? {} : { template }),
          // Trust is local to this application session. Even a literal
          // `trusted: true` in the project file is untrusted input.
          trusted: false,
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
  const stored: StoredAgent[] = entries.map(({ agent, template }) => ({
    id: agent.id,
    name: agent.name,
    harness: agent.binding.harness,
    model: agent.binding.model,
    reasoningEffort: agent.binding.reasoningEffort,
    ...(template === undefined ? {} : { template }),
  }));

  replaceStateFileAtomically(fileFor(stateDir), `${JSON.stringify(stored, null, 2)}\n`);
};
