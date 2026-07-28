import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type AgentComment, type Proposal, replaceStateFileAtomically } from "@refrain/core";
import { reviewTaskScopeConflict } from "./review-task.ts";
import type { ReviewTask, RunState, TaskContextScope, TaskEditScope } from "./types.ts";

export interface StoredRun {
  readonly id: string;
  readonly state: RunState;
  readonly task: ReviewTask;
  readonly failure?: string;
  readonly comments: readonly AgentComment[];
  readonly proposals: readonly Proposal[];
}

export interface HostState {
  readonly version: 2;
  readonly sequence: number;
  readonly queue: readonly ReviewTask[];
  readonly runs: readonly StoredRun[];
  readonly drifted: readonly string[];
}

export interface HostStateDiagnostic {
  readonly source: string;
  readonly path: string;
  readonly reason: "read-failed" | "invalid-json" | "invalid-envelope" | "invalid-record";
  /** Exact invalid bytes retained before a later healthy write can replace them. */
  readonly evidencePath?: string;
}

export const emptyHostState = (): HostState => ({
  version: 2,
  sequence: 0,
  queue: [],
  runs: [],
  drifted: [],
});

const warnDiagnostic = (diagnostic: HostStateDiagnostic): void => {
  const detail = {
    "read-failed": "read failure",
    "invalid-json": "invalid JSON",
    "invalid-envelope": "invalid top-level shape",
    "invalid-record": "invalid record",
  }[diagnostic.reason];
  console.warn(
    `ignored HostState ${detail} at ${diagnostic.path} in ${diagnostic.source}` +
      (diagnostic.evidencePath === undefined
        ? ""
        : `; original preserved at ${diagnostic.evidencePath}`),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && entry.trim().length > 0);

const isContextScope = (value: unknown): value is TaskContextScope => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0)
    return false;
  if (value.kind === "legacy-reference") return Object.keys(value).length === 2;
  return (
    value.kind === "material" && typeof value.text === "string" && Object.keys(value).length === 3
  );
};

const isTask = (value: unknown): value is ReviewTask => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.contextScope) ||
    !value.contextScope.every(isContextScope) ||
    !Array.isArray(value.editScopes)
  )
    return false;
  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.agentId !== "string" ||
    value.agentId.trim().length === 0 ||
    typeof value.baseline !== "string" ||
    value.baseline.trim().length === 0 ||
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0
  )
    return false;
  const editScopes: TaskEditScope[] = [];
  for (const scope of value.editScopes) {
    if (
      !isRecord(scope) ||
      typeof scope.id !== "string" ||
      scope.id.trim().length === 0 ||
      !isStringArray(scope.blockIds) ||
      new Set(scope.blockIds).size !== scope.blockIds.length ||
      typeof scope.text !== "string"
    )
      return false;
    editScopes.push({ id: scope.id, blockIds: scope.blockIds, text: scope.text });
  }
  return reviewTaskScopeConflict(value.contextScope, editScopes) === undefined;
};

const isComment = (value: unknown): value is AgentComment =>
  isRecord(value) &&
  typeof value.target === "string" &&
  value.target.trim().length > 0 &&
  typeof value.text === "string";

const isProposal = (value: unknown): value is Proposal =>
  isRecord(value) &&
  typeof value.id === "string" &&
  value.id.trim().length > 0 &&
  typeof value.runId === "string" &&
  value.runId.trim().length > 0 &&
  typeof value.baseline === "string" &&
  value.baseline.trim().length > 0 &&
  isRecord(value.scope) &&
  typeof value.scope.id === "string" &&
  value.scope.id.trim().length > 0 &&
  isStringArray(value.scope.blockIds) &&
  new Set(value.scope.blockIds).size === value.scope.blockIds.length &&
  typeof value.before === "string" &&
  (typeof value.after === "string" || value.after === null);

const isRunState = (value: unknown): value is RunState =>
  value === "dispatched" || value === "completed" || value === "failed" || value === "cancelled";

const sequenceFromRunId = (id: string): number | undefined => {
  const match = /^run([1-9]\d*)$/.exec(id);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
};

const isStoredRun = (value: unknown): value is StoredRun => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    sequenceFromRunId(value.id) === undefined ||
    !isRunState(value.state) ||
    !isTask(value.task) ||
    (value.failure !== undefined && typeof value.failure !== "string") ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isComment) ||
    !Array.isArray(value.proposals) ||
    !value.proposals.every(isProposal)
  )
    return false;
  if (value.state !== "completed")
    return value.comments.length === 0 && value.proposals.length === 0;

  const task = value.task as ReviewTask;
  const scopes = new Map(task.editScopes.map((scope) => [scope.id, scope]));
  const commentTargets = new Set([...task.contextScope.map((scope) => scope.id), ...scopes.keys()]);
  const proposalIds = new Set<string>();
  const proposalScopes = new Set<string>();
  const proposalsMatch = value.proposals.every((proposal) => {
    const scope = scopes.get(proposal.scope.id);
    if (proposalIds.has(proposal.id) || proposalScopes.has(proposal.scope.id)) return false;
    proposalIds.add(proposal.id);
    proposalScopes.add(proposal.scope.id);
    return (
      scope !== undefined &&
      proposal.runId === value.id &&
      proposal.baseline === task.baseline &&
      proposal.before === scope.text &&
      proposal.scope.blockIds.length === scope.blockIds.length &&
      proposal.scope.blockIds.every((id, index) => id === scope.blockIds[index])
    );
  });
  return proposalsMatch && value.comments.every((comment) => commentTargets.has(comment.target));
};

interface HostStateEnvelope extends Record<string, unknown> {
  readonly version: 1 | 2;
}

const isHostStateEnvelope = (value: unknown): value is HostStateEnvelope =>
  isRecord(value) && (value.version === 1 || value.version === 2);

const invalidRecord = (
  source: string,
  path: string,
  report: (diagnostic: HostStateDiagnostic) => void,
): void => report({ source, path, reason: "invalid-record" });

const validSequence = (
  value: unknown,
  source: string,
  report: (diagnostic: HostStateDiagnostic) => void,
): number => {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  invalidRecord(source, "$.sequence", report);
  return 0;
};

const validRecords = <T>(
  records: unknown,
  isValid: (record: unknown) => record is T,
  collection: "queue" | "runs",
  source: string,
  report: (diagnostic: HostStateDiagnostic) => void,
  identity: (record: T) => string,
): T[] => {
  if (!Array.isArray(records)) {
    invalidRecord(source, `$.${collection}`, report);
    return [];
  }

  const valid: T[] = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!isValid(record)) {
      invalidRecord(source, `$.${collection}[${index}]`, report);
      continue;
    }
    const id = identity(record);
    if (seen.has(id)) {
      invalidRecord(source, `$.${collection}[${index}]`, report);
      continue;
    }
    seen.add(id);
    valid.push(record);
  }
  return valid;
};

const validStrings = (
  records: unknown,
  collection: "drifted",
  source: string,
  report: (diagnostic: HostStateDiagnostic) => void,
): string[] => {
  if (!Array.isArray(records)) {
    invalidRecord(source, `$.${collection}`, report);
    return [];
  }

  const valid: string[] = [];
  for (const [index, record] of records.entries()) {
    if (typeof record === "string") valid.push(record);
    else invalidRecord(source, `$.${collection}[${index}]`, report);
  }
  return valid;
};

const pathFor = (root: string): string => join(root, "host.json");

const preserveInvalidState = (source: string): string | undefined => {
  const parent = dirname(source);
  const timestamp = Date.now();
  for (let sequence = 0; sequence < 1_000; sequence += 1) {
    const suffix = new Date(timestamp + sequence).toISOString().replaceAll(":", "-");
    const evidence = `${source}.invalid-${suffix}`;
    let created = false;
    try {
      linkSync(source, evidence);
      created = true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
        continue;
    }
    if (!created) {
      try {
        copyFileSync(source, evidence, constants.COPYFILE_EXCL);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          continue;
        return undefined;
      }
    }
    try {
      // O_RDWR, not O_RDONLY: Windows refuses to flush a handle that carries no
      // write access, and this evidence file must be durable before the rename.
      const file = openSync(evidence, constants.O_RDWR);
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      if (process.platform !== "win32") {
        const directory = openSync(parent, constants.O_RDONLY);
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
    } catch {
      return undefined;
    }
    return evidence;
  }
  return undefined;
};

const migrateTask = (value: unknown, version: 1 | 2): unknown => {
  if (version !== 1 || !isRecord(value) || !Array.isArray(value.contextScope)) return value;
  return {
    ...value,
    contextScope: value.contextScope.map((entry) =>
      typeof entry === "string" ? { kind: "legacy-reference", id: entry } : entry,
    ),
  };
};

const migrateRun = (value: unknown, version: 1 | 2): unknown =>
  version === 1 && isRecord(value) ? { ...value, task: migrateTask(value.task, version) } : value;

/** A corrupt collaboration snapshot never prevents the manuscript from opening. */
export const readHostState = (
  root: string,
  report: (diagnostic: HostStateDiagnostic) => void = warnDiagnostic,
): HostState => {
  const source = pathFor(root);
  if (!existsSync(source)) return emptyHostState();
  let preservationAttempted = false;
  let evidencePath: string | undefined;
  const diagnose = (diagnostic: HostStateDiagnostic): void => {
    if (!preservationAttempted) {
      preservationAttempted = true;
      evidencePath = preserveInvalidState(source);
    }
    report(evidencePath === undefined ? diagnostic : { ...diagnostic, evidencePath });
  };
  let serialized: string;
  try {
    serialized = readFileSync(source, "utf8");
  } catch {
    diagnose({ source, path: "$", reason: "read-failed" });
    return emptyHostState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    diagnose({ source, path: "$", reason: "invalid-json" });
    return emptyHostState();
  }

  if (!isHostStateEnvelope(parsed)) {
    diagnose({ source, path: "$", reason: "invalid-envelope" });
    return emptyHostState();
  }
  const queue = validRecords(
    Array.isArray(parsed.queue)
      ? parsed.queue.map((task) => migrateTask(task, parsed.version))
      : parsed.queue,
    isTask,
    "queue",
    source,
    diagnose,
    (task) => task.id,
  );
  const runs = validRecords(
    Array.isArray(parsed.runs)
      ? parsed.runs.map((run) => migrateRun(run, parsed.version))
      : parsed.runs,
    isStoredRun,
    "runs",
    source,
    diagnose,
    (run) => run.id,
  );
  const runSequence = runs.reduce(
    (highest, run) => Math.max(highest, sequenceFromRunId(run.id) ?? 0),
    0,
  );
  return {
    version: 2,
    sequence: Math.max(validSequence(parsed.sequence, source, diagnose), runSequence),
    queue,
    runs,
    drifted: validStrings(parsed.drifted, "drifted", source, diagnose),
  };
};

export const writeHostState = (root: string, state: HostState): void => {
  replaceStateFileAtomically(pathFor(root), `${JSON.stringify(state, null, 2)}\n`);
};
