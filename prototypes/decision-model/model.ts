// PROTOTYPE — throwaway. Answers one question; see README.md.
// The logic below is portable: no I/O, no terminal, no console.
// If the model proves out, this file lifts into packages/core.

// ── Domain (SPEC §2) ────────────────────────────────────────────────

export type BlockId = string;
export type HeadId = string;
export type RevisionId = string;

export interface Block {
  id: BlockId;
  text: string;
}

/** Immutable manuscript state produced by one Text Action. */
export interface TextHead {
  id: HeadId;
  blocks: Block[];
  cause: string;
}

/** A contiguous run of blocks a run may replace. */
export interface EditScope {
  id: string;
  blockIds: BlockId[];
}

export interface Proposal {
  id: string;
  agent: string;
  baseline: RevisionId;
  scope: EditScope;
  before: string;
  after: string | null; // null = delete the scope
}

export type SliceKind = "same" | "del" | "ins";

export interface ReviewSlice {
  id: string;
  kind: SliceKind;
  text: string;
}

export type VerdictKind = "accept" | "accept-modified" | "reject";

export interface Verdict {
  id: string;
  proposalId: string;
  sliceId: string;
  kind: VerdictKind;
  finalText?: string;
  reason?: string;
  baseline: RevisionId;
  decidedAt: string;
}

export interface Revision {
  id: RevisionId;
  head: HeadId;
}

// ── Manuscript ──────────────────────────────────────────────────────

export const serialize = (h: TextHead): string => h.blocks.map((b) => b.text).join("\n\n");

export const scopeText = (h: TextHead, scope: EditScope): string | null => {
  const parts = scope.blockIds.map((id) => h.blocks.find((b) => b.id === id)?.text);
  return parts.some((t) => t === undefined) ? null : parts.join("\n\n");
};

/** One Text Action: replace each scope's blocks with new text. Returns a new head. */
export const applyChanges = (
  head: TextHead,
  changes: { scope: EditScope; text: string | null }[],
  cause: string,
): TextHead => {
  const blocks: Block[] = [];
  const consumed = new Set<BlockId>();
  for (const b of head.blocks) {
    if (consumed.has(b.id)) continue;
    const hit = changes.find((c) => c.scope.blockIds[0] === b.id);
    if (!hit) {
      blocks.push(b);
      continue;
    }
    for (const id of hit.scope.blockIds) consumed.add(id);
    if (hit.text !== null) {
      hit.text
        .split(/\n\n+/)
        .forEach((t, i) => blocks.push({ id: `${hit.scope.blockIds[0]}~${i}`, text: t }));
    }
  }
  return { id: `h${nextId()}`, blocks, cause };
};

// ── Review slices: sentence-level LCS ───────────────────────────────

const sentences = (t: string): string[] =>
  t.split(/(?<=[。！？!?.])\s*/).filter((s) => s.trim().length > 0);

export const sliceProposal = (p: Proposal): ReviewSlice[] => {
  const a = sentences(p.before);
  const b = p.after === null ? [] : sentences(p.after);
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: ReviewSlice[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const push = (kind: SliceKind, text: string) =>
    out.push({ id: `${p.id}.s${k++}`, kind, text });

  while (i < n && j < m) {
    if (a[i] === b[j]) push("same", a[i++]), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("del", a[i++]);
    else push("ins", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return out;
};

/**
 * Rebuild one scope's final replacement from staged verdicts.
 * An unstaged slice counts as rejected — the conservative reading keeps the original.
 */
export const rebuild = (slices: ReviewSlice[], staged: Map<string, Verdict>): string => {
  const kept: string[] = [];
  for (const s of slices) {
    const v = staged.get(s.id);
    const accepted = v?.kind === "accept" || v?.kind === "accept-modified";
    if (s.kind === "same") kept.push(s.text);
    else if (s.kind === "del" && !accepted) kept.push(s.text);
    else if (s.kind === "ins" && accepted) kept.push(v?.finalText ?? s.text);
  }
  return kept.join("");
};

// ── Decision Batch (SPEC §7.4) ──────────────────────────────────────

export type MapResult =
  | { ok: true; scope: EditScope; text: string | null }
  | { ok: false; proposalId: string; why: "missing-blocks" | "before-text-changed"; current: string | null };

/** Map one proposal's rebuilt text from its own baseline onto the current head. */
export const mapOnto = (
  head: TextHead,
  p: Proposal,
  rebuilt: string,
): MapResult => {
  const current = scopeText(head, p.scope);
  if (current === null) return { ok: false, proposalId: p.id, why: "missing-blocks", current };
  if (current !== p.before)
    return { ok: false, proposalId: p.id, why: "before-text-changed", current };
  return { ok: true, scope: p.scope, text: rebuilt.length === 0 ? null : rebuilt };
};

export type CommitResult =
  | { ok: true; head: TextHead; revision: Revision; verdicts: Verdict[] }
  | { ok: false; reason: string; detail: string[] };

/**
 * Compile staged verdicts into ONE Text Action.
 * Refuses the whole batch on any conflict — the system never picks a winner
 * by hidden ordering (SPEC §7.4 rule 4).
 */
export const commitBatch = (
  head: TextHead,
  proposals: Proposal[],
  staged: Map<string, Verdict>,
): CommitResult => {
  const active = proposals.filter((p) =>
    sliceProposal(p).some((s) => staged.has(s.id)),
  );
  if (active.length === 0) return { ok: false, reason: "nothing staged", detail: [] };

  const mapped: { scope: EditScope; text: string | null }[] = [];
  const failures: string[] = [];
  for (const p of active) {
    const r = mapOnto(head, p, rebuild(sliceProposal(p), staged));
    if (r.ok) mapped.push({ scope: r.scope, text: r.text });
    else
      failures.push(
        `${p.id} (${p.agent}): ${r.why === "missing-blocks" ? "target blocks no longer exist" : "manuscript changed under this proposal"}`,
      );
  }
  if (failures.length > 0) return { ok: false, reason: "three-way conflict", detail: failures };

  // Pairwise disjointness — overlapping changes cannot be ordered by the system.
  for (let x = 0; x < mapped.length; x++)
    for (let y = x + 1; y < mapped.length; y++) {
      const overlap = mapped[x].scope.blockIds.filter((id) =>
        mapped[y].scope.blockIds.includes(id),
      );
      if (overlap.length > 0)
        return {
          ok: false,
          reason: "overlapping scopes",
          detail: [
            `${mapped[x].scope.id} and ${mapped[y].scope.id} both touch ${overlap.join(", ")}`,
            "resolve by staging one, or write a single replacement over the union",
          ],
        };
    }

  const next = applyChanges(head, mapped, `decision-batch(${active.map((p) => p.id).join(",")})`);
  return {
    ok: true,
    head: next,
    revision: { id: `r${nextId()}`, head: next.id },
    verdicts: [...staged.values()],
  };
};

/** Does merge(A then B) equal merge(B then A)? Disjoint proposals must commute. */
export const commutes = (
  head: TextHead,
  a: { scope: EditScope; text: string | null },
  b: { scope: EditScope; text: string | null },
): boolean =>
  serialize(applyChanges(applyChanges(head, [a], "x"), [b], "y")) ===
  serialize(applyChanges(applyChanges(head, [b], "x"), [a], "y"));

let counter = 0;
export const nextId = (): number => ++counter;
