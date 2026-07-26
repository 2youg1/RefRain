/**
 * Session state and the freeze rule (design plan §3.4).
 *
 * An agent's identity is its session's native context plus an immutable
 * runtime binding. Compaction destroys the first half: most harnesses cannot
 * recall the original conversation afterwards, so the application can no
 * longer prove the context it is talking to is the one it started with.
 *
 * Hence the hard rule: reaching the threshold, or a compaction event of any
 * kind, freezes the session permanently. Raising the threshold afterwards does
 * not thaw it, because the threshold was never the thing that broke — the
 * lineage was. Work continues on a derived agent, which is honest about being
 * a different one.
 *
 * Dispatch is decided on *projected* usage rather than current usage: by the
 * time current usage crosses a threshold, the tokens are already spent.
 */

export type FreezeCause = "threshold" | "compaction";

export interface SessionState {
  readonly agentId: string;
  readonly state: "active" | "frozen";
  /** null when the harness reports no context window. */
  readonly capacity: number | null;
  readonly threshold: number;
  readonly used: number;
  readonly lineageVerifiable: boolean;
  readonly frozenBecause?: FreezeCause;
  readonly frozenAt?: string;
}

export type DispatchRefusal = "frozen" | "capacity-unknown" | "would-cross-threshold";

export type DispatchVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DispatchRefusal };

export interface RunEstimate {
  readonly input: number;
  readonly maxOutput: number;
}

export interface Projection {
  readonly current: number;
  readonly input: number;
  readonly maxOutput: number;
  readonly margin: number;
  readonly total: number;
  readonly limit: number | null;
}

/**
 * A safety margin the adapter cannot account for: system prompt growth, tool
 * definitions, and whatever the harness adds between the estimate and the
 * call. Stated as a constant so it appears in the projection rather than
 * hiding inside a comparison.
 */
const SAFETY_MARGIN = 2_000;

export const newSession = (spec: {
  agentId: string;
  capacity: number | null;
  threshold: number;
}): SessionState => ({
  agentId: spec.agentId,
  state: "active",
  capacity: spec.capacity,
  threshold: spec.threshold,
  used: 0,
  lineageVerifiable: true,
});

export const recordUsage = (session: SessionState, used: number): SessionState => ({
  ...session,
  used,
});

export const projectUsage = (session: SessionState, run: RunEstimate): Projection => ({
  current: session.used,
  input: run.input,
  maxOutput: run.maxOutput,
  margin: SAFETY_MARGIN,
  total: session.used + run.input + run.maxOutput + SAFETY_MARGIN,
  limit: session.capacity === null ? null : session.capacity * session.threshold,
});

export const canDispatch = (session: SessionState, run: RunEstimate): DispatchVerdict => {
  if (session.state === "frozen") return { ok: false, reason: "frozen" };
  if (session.capacity === null) return { ok: false, reason: "capacity-unknown" };

  const projection = projectUsage(session, run);
  return projection.limit !== null && projection.total >= projection.limit
    ? { ok: false, reason: "would-cross-threshold" }
    : { ok: true };
};

export const freeze = (session: SessionState, because: FreezeCause): SessionState => ({
  ...session,
  state: "frozen",
  frozenBecause: because,
  frozenAt: new Date().toISOString(),
  // Compaction is what makes the lineage unprovable; a threshold stop happens
  // before the context is touched, so the record is still intact.
  lineageVerifiable: because === "threshold" ? session.lineageVerifiable : false,
});

/** Permitted while active, and deliberately powerless once frozen. */
export const raiseThreshold = (session: SessionState, threshold: number): SessionState =>
  session.state === "frozen" ? session : { ...session, threshold };
