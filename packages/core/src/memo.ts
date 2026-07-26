import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMemo } from "./artifact.ts";

/**
 * Agent working memory, kept as Markdown on disk.
 *
 * Markdown rather than SQLite, and one file per agent rather than one table:
 * the author has to be able to read this, disagree with it, and edit it in any
 * text editor without the application running. A memo is an agent's account of
 * its own work — a claim, not evidence — so the human keeps the pen.
 *
 * This is what replaces the withdrawn "taste profile". That was to be induced
 * by an application with no model and no network, which was never possible.
 * The memo is written by the party that actually had the context: the agent,
 * at the moment it still held it. Its purpose is continuity across a
 * discontinuity — a cloned session, a compaction, a successor agent — and it
 * is the only thing that survives one.
 */

export interface MemoEntry {
  readonly agentId: string;
  readonly runId: string;
  readonly at: string;
  readonly topic?: string;
  readonly text: string;
}

const pathFor = (stateDir: string, agentId: string): string =>
  join(stateDir, "memos", `${agentId}.md`);

/**
 * Appended, never rewritten. An agent revising its own history would erase the
 * record of what it used to believe, and that record is what lets the author
 * see a standard drift.
 */
export const appendMemos = (
  stateDir: string,
  agentId: string,
  runId: string,
  memos: readonly AgentMemo[],
): void => {
  if (memos.length === 0) return;

  const file = pathFor(stateDir, agentId);
  mkdirSync(dirname(file), { recursive: true });

  const at = new Date().toISOString();
  const body = memos
    .map((memo) => {
      const heading = memo.topic === undefined ? `## ${at}` : `## ${at} · ${memo.topic}`;
      return `${heading}\n\n<!-- run ${runId} -->\n\n${memo.text.trim()}\n`;
    })
    .join("\n");

  const header = existsSync(file) ? "" : `# ${agentId} 的工作记忆\n\n`;
  appendFileSync(file, `${header}${body}\n`, "utf8");
};

/** The memo file as the author would read it, or nothing when none was written. */
export const readMemos = (stateDir: string, agentId: string): string | undefined => {
  const file = pathFor(stateDir, agentId);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/**
 * The memo as it travels into a successor's first round.
 *
 * Trimmed from the end, because the newest entries describe the manuscript as
 * it stands now. The cap is a character budget rather than an entry count: an
 * agent that writes one long memo and one that writes twenty short ones should
 * cost the author the same.
 */
export const carryForward = (
  stateDir: string,
  agentId: string,
  budget = 4_000,
): string | undefined => {
  const whole = readMemos(stateDir, agentId);
  if (whole === undefined) return undefined;

  const body = whole.length <= budget ? whole : `…\n${whole.slice(-budget)}`;
  return `<memory agent="${agentId}">\n${body.trim()}\n</memory>`;
};
