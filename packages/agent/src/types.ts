import type { BlockId, Persona, PersonaCarry, RevisionId } from "@refrain/core";

/** Harness capability tier (SPEC 6.1). Missing capability degrades and is labeled. */
export type Tier = "L0" | "L1" | "L2";

export type Capability<T> =
  | { readonly kind: "actual"; readonly value: T }
  | { readonly kind: "estimated"; readonly value: T; readonly method: string }
  | { readonly kind: "unknown" };

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Readonly<Record<string, TokenUsage>>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
}

/** Harness, model, and reasoning effort, locked at agent creation. Runs inherit; never override. */
export interface RuntimeBinding {
  readonly harness: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

/**
 * A collaborator: one session, one immutable runtime binding, and the standing
 * identity the author wrote for it.
 *
 * Identity is what separates two agents on the same harness and the same
 * model. A line editor and a structural reader can share every runtime
 * setting and still be different collaborators, because the brief they work
 * under differs — which is why `persona` sits beside `binding` rather than
 * inside it, and why it stays editable while the binding never is.
 */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly binding: RuntimeBinding;
  readonly persona?: Persona;
  /** Whether the brief travels every round, only the first, or never. */
  readonly personaCarry?: PersonaCarry;
}

/** A manuscript slot a run may replace, carrying the text at the baseline Revision. */
export interface TaskEditScope {
  readonly id: string;
  readonly blockIds: readonly BlockId[];
  readonly text: string;
}

export interface ReviewTask {
  readonly id: string;
  readonly agentId: string;
  readonly baseline: RevisionId;
  readonly prompt: string;
  /** What the run may read. Readable is not writable. */
  readonly contextScope: readonly string[];
  readonly editScopes: readonly TaskEditScope[];
}

export type RunState = "dispatched" | "completed" | "failed" | "cancelled";

export interface Run {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly baseline: RevisionId;
  /** The run's exclusive write area. The app never deletes it automatically. */
  readonly workspace: string;
  readonly requestPath: string;
  readonly resultPath: string;
  state: RunState;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly tier: Tier;
  dispatch(run: Run, task: ReviewTask, agent: Agent): Promise<void>;
  cancel(run: Run): Promise<void>;
  usage(): Capability<SessionUsage>;
  effectiveModel(): Capability<string>;
}
