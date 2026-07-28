import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { replaceStateFileAtomically } from "./atomic-file.ts";
import type { TextHead } from "./domain.ts";
import type { VerdictLedger } from "./ledger.ts";
import {
  commitChapterWrite,
  type FileStamp,
  prepareChapterWrite,
  readChapterFile,
  type WriteOutcome,
} from "./project.ts";
import type { Verdict } from "./verdict.ts";

interface DecisionCommitIntent {
  readonly version: 1;
  readonly path: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly verdicts: readonly Verdict[];
}

export interface DecisionRecovery {
  readonly ok: boolean;
  readonly detail?: string;
}

const intentPath = (stateDir: string): string => join(stateDir, "decision-commit.json");
const digest = (content: string): string => createHash("sha256").update(content).digest("hex");

const isVerdict = (value: unknown): value is Verdict => {
  if (typeof value !== "object" || value === null) return false;
  const verdict = value as Partial<Verdict>;
  return (
    typeof verdict.id === "string" &&
    typeof verdict.proposalId === "string" &&
    typeof verdict.kind === "string" &&
    typeof verdict.baseline === "string" &&
    typeof verdict.decidedAt === "string"
  );
};

const readIntent = (stateDir: string): DecisionCommitIntent | undefined => {
  const path = intentPath(stateDir);
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null)
    throw new Error("invalid Decision Batch recovery file");
  const intent = value as Partial<DecisionCommitIntent>;
  const projectRoot = dirname(stateDir);
  const chapterPath = typeof intent.path === "string" ? resolve(intent.path) : "";
  const outside = relative(projectRoot, chapterPath);
  if (
    intent.version !== 1 ||
    chapterPath === "" ||
    outside === ".." ||
    outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    typeof intent.beforeDigest !== "string" ||
    typeof intent.afterDigest !== "string" ||
    !Array.isArray(intent.verdicts) ||
    !intent.verdicts.every(isVerdict)
  )
    throw new Error("invalid Decision Batch recovery file");
  return {
    version: 1,
    path: chapterPath,
    beforeDigest: intent.beforeDigest,
    afterDigest: intent.afterDigest,
    verdicts: intent.verdicts,
  };
};

const finishIntent = (stateDir: string): void => unlinkSync(intentPath(stateDir));

/**
 * Persist the manuscript and its Verdicts as one recoverable decision.
 *
 * The intent reaches disk first. A crash before rename leaves the old chapter
 * and no Verdicts; a crash after rename is completed into the ledger when the
 * Workbench reopens. Duplicate recovery is harmless because Verdict IDs are
 * immutable and idempotent.
 */
export const persistDecisionCommit = (
  stateDir: string,
  chapterPath: string,
  expected: FileStamp,
  head: TextHead,
  verdicts: readonly Verdict[],
  ledger: VerdictLedger,
): WriteOutcome => {
  if (existsSync(intentPath(stateDir))) throw new Error("a Decision Batch is awaiting recovery");
  const prepared = prepareChapterWrite(chapterPath, head, expected, dirname(stateDir));
  if (!prepared.ok) return prepared;
  const intent: DecisionCommitIntent = {
    version: 1,
    path: chapterPath,
    beforeDigest: expected.digest,
    afterDigest: digest(prepared.content),
    verdicts,
  };
  replaceStateFileAtomically(intentPath(stateDir), `${JSON.stringify(intent, null, 2)}\n`);

  let outcome: WriteOutcome;
  try {
    outcome = commitChapterWrite(prepared);
  } catch (error) {
    if (readChapterFile(chapterPath)?.stamp.digest === expected.digest) finishIntent(stateDir);
    throw error;
  }
  if (!outcome.ok) {
    finishIntent(stateDir);
    return outcome;
  }

  ledger.recordAll(verdicts);
  finishIntent(stateDir);
  return outcome;
};

/** Complete or abort an interrupted Decision Batch from disk evidence alone. */
export const recoverDecisionCommit = (
  stateDir: string,
  ledger: VerdictLedger,
): DecisionRecovery => {
  let intent: DecisionCommitIntent | undefined;
  try {
    intent = readIntent(stateDir);
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
  if (!intent) return { ok: true };

  const actual = readChapterFile(intent.path);
  if (!actual) return { ok: false, detail: `Decision Batch chapter is missing: ${intent.path}` };
  if (actual.stamp.digest === intent.beforeDigest) {
    finishIntent(stateDir);
    return { ok: true };
  }
  if (actual.stamp.digest !== intent.afterDigest)
    return { ok: false, detail: `Decision Batch chapter changed during recovery: ${intent.path}` };

  try {
    ledger.recordAll(intent.verdicts);
    finishIntent(stateDir);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
};
