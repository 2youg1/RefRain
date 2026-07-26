import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentComment, type Proposal, replaceFileAtomically } from "@refrain/core";
import type { ReviewTask, RunState } from "./types.ts";

export interface StoredRun {
  readonly id: string;
  readonly state: RunState;
  readonly task: ReviewTask;
  readonly failure?: string;
  readonly comments: readonly AgentComment[];
  readonly proposals: readonly Proposal[];
}

export interface HostState {
  readonly version: 1;
  readonly sequence: number;
  readonly queue: readonly ReviewTask[];
  readonly runs: readonly StoredRun[];
  readonly drifted: readonly string[];
}

export const emptyHostState = (): HostState => ({
  version: 1,
  sequence: 0,
  queue: [],
  runs: [],
  drifted: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isTask = (value: unknown): value is ReviewTask => {
  if (!isRecord(value) || !isStringArray(value.contextScope) || !Array.isArray(value.editScopes))
    return false;
  if (
    typeof value.id !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.baseline !== "string" ||
    typeof value.prompt !== "string"
  )
    return false;
  return value.editScopes.every(
    (scope) =>
      isRecord(scope) &&
      typeof scope.id === "string" &&
      isStringArray(scope.blockIds) &&
      typeof scope.text === "string",
  );
};

const isComment = (value: unknown): value is AgentComment =>
  isRecord(value) && typeof value.target === "string" && typeof value.text === "string";

const isProposal = (value: unknown): value is Proposal =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.runId === "string" &&
  typeof value.baseline === "string" &&
  isRecord(value.scope) &&
  typeof value.scope.id === "string" &&
  isStringArray(value.scope.blockIds) &&
  typeof value.before === "string" &&
  (typeof value.after === "string" || value.after === null);

const isRunState = (value: unknown): value is RunState =>
  value === "dispatched" || value === "completed" || value === "failed" || value === "cancelled";

const isStoredRun = (value: unknown): value is StoredRun =>
  isRecord(value) &&
  typeof value.id === "string" &&
  isRunState(value.state) &&
  isTask(value.task) &&
  (value.failure === undefined || typeof value.failure === "string") &&
  Array.isArray(value.comments) &&
  value.comments.every(isComment) &&
  Array.isArray(value.proposals) &&
  value.proposals.every(isProposal);

const isHostState = (value: unknown): value is HostState =>
  isRecord(value) &&
  value.version === 1 &&
  Number.isSafeInteger(value.sequence) &&
  Number(value.sequence) >= 0 &&
  Array.isArray(value.queue) &&
  value.queue.every(isTask) &&
  Array.isArray(value.runs) &&
  value.runs.every(isStoredRun) &&
  isStringArray(value.drifted);

const pathFor = (root: string): string => join(root, "host.json");

/** A corrupt collaboration snapshot never prevents the manuscript from opening. */
export const readHostState = (root: string): HostState => {
  const path = pathFor(root);
  if (!existsSync(path)) return emptyHostState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHostState(parsed) ? parsed : emptyHostState();
  } catch {
    return emptyHostState();
  }
};

export const writeHostState = (root: string, state: HostState): void => {
  replaceFileAtomically(pathFor(root), `${JSON.stringify(state, null, 2)}\n`);
};
