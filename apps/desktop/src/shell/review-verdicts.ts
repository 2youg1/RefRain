/**
 * 裁决的规则。
 *
 * 账本按 slice 记，进度按 unit 算（SPEC 9.7）——这条不对称是裁决界面全部复杂度的
 * 来源：作者眼里的一次判断，落到账本上可能是两行；一个合并单元只有每个 slice 都有
 * 行才算已决。
 *
 * 这 200 行此前住在 `ReviewSurface.tsx` 里，文件顶部的注释已经写明「上半部是纯函数，
 * 不碰信号」——那句话本身就是在说它们该独立成文件。困在组件里的代价是没人能验证：
 * 「哪些裁决算已决」「合并单元的 accept-modified 该往哪一行写最终文本」这类问题
 * 全无测试，而它们恰恰是作者的字会不会被写错的地方。
 */

import type {
  ProposalDto,
  ReviewSliceDto,
  VerdictKindName,
  VerdictRecord,
} from "../generated/bindings.gen";

/** 一个 Unit 是作者眼里的一次判断；账本仍按 slice 记（SPEC 9.7）。 */
export interface Unit {
  proposalId: string;
  proposalRun: string;
  before: string;
  after: string;
  kind: "replace" | "delete" | "insert";
  slices: ReviewSliceDto[];
  competing: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// 状态：判别联合，不用一排独立 boolean / 可空字段。
// ──────────────────────────────────────────────────────────────────────────

/** 原 `state: ReviewStateDto | null`：「还没读到」与「读到了但没提案」是两件事。 */
export type Session = { kind: "loading" } | { kind: "ready"; proposals: readonly ProposalDto[] };

/** 原 `editingFinal: string | null`：右栏是在看还是在改。 */
export type Pane = { kind: "reading" } | { kind: "editing"; text: string };

/** 原 `reasonDraft: string | null`：理由给了没给。 */
export type Reason = { kind: "unstated" } | { kind: "stated"; text: string };

/** 原 `competingPeer: boolean`：换看竞争稿，A / B 是两个具名面而不是真假。 */
export type Peer = { kind: "a" } | { kind: "b" };

/** 原 `error: string | null`：区分「规矩没走对」与「桥上失败」。 */
export type Notice =
  | { kind: "silent" }
  | { kind: "refused"; text: string }
  | { kind: "failed"; text: string };

/** 当前 Unit 相对账本与批次的位置：原 verdictOf/isStaged 两个可空判断的合体。 */
export type Standing =
  | { kind: "undecided" }
  | { kind: "decided"; verdict: VerdictRecord }
  | { kind: "staged"; verdict: VerdictRecord };

// ──────────────────────────────────────────────────────────────────────────
// 纯函数。
// ──────────────────────────────────────────────────────────────────────────

function competitorsExist(proposals: readonly ProposalDto[], proposal: ProposalDto): boolean {
  return proposals.some(
    (other) => other.id !== proposal.id && other.baseline === proposal.baseline,
  );
}

export function unitsOf(proposals: readonly ProposalDto[]): Unit[] {
  const out: Unit[] = [];
  for (const proposal of proposals) {
    const changed = proposal.slices.filter((slice) => slice.kind !== "same");
    const competing = competitorsExist(proposals, proposal);
    for (let i = 0; i < changed.length; i += 1) {
      const slice = changed[i];
      if (slice === undefined) continue;
      const next = changed[i + 1];
      if (slice.kind === "delete" && next?.kind === "insert") {
        out.push({
          proposalId: proposal.id,
          proposalRun: proposal.run,
          before: slice.text,
          after: next.text,
          kind: "replace",
          slices: [slice, next],
          competing,
        });
        i += 1;
      } else {
        out.push({
          proposalId: proposal.id,
          proposalRun: proposal.run,
          before: slice.kind === "insert" ? "" : slice.text,
          after: slice.kind === "delete" ? "" : slice.text,
          kind: slice.kind === "delete" ? "delete" : slice.kind === "insert" ? "insert" : "replace",
          slices: [slice],
          competing,
        });
      }
    }
  }
  return out;
}

export type Ledger = ReadonlyMap<string, VerdictRecord>;

// Counts are per Unit: a unit is decided when every slice in it has a row
// (SPEC 9.7: the ledger is slice-granular, the progress is unit-granular).
export function decidedCount(units: readonly Unit[], ledger: Ledger): number {
  return units.filter((unit) => unit.slices.every((slice) => ledger.has(slice.id))).length;
}

export function verdictIdsOf(unit: Unit, ledger: Ledger): string[] {
  return unit.slices
    .map((slice) => ledger.get(slice.id)?.id)
    .filter((id): id is string => id !== undefined);
}

export function standingOf(
  unit: Unit | null,
  ledger: Ledger,
  batch: ReadonlySet<string>,
): Standing {
  if (unit === null) return { kind: "undecided" };
  let found: VerdictRecord | undefined;
  for (const slice of unit.slices) {
    const row = ledger.get(slice.id);
    if (row !== undefined) {
      found = row;
      break;
    }
  }
  if (found === undefined) return { kind: "undecided" };
  const ids = verdictIdsOf(unit, ledger);
  const allStaged = ids.length > 0 && ids.every((id) => batch.has(id));
  return allStaged ? { kind: "staged", verdict: found } : { kind: "decided", verdict: found };
}

export function actionLabel(unit: Unit | null): string {
  if (unit === null) return "";
  switch (unit.kind) {
    case "replace":
      return "采用改写";
    case "delete":
      return "删除此句";
    case "insert":
      return "写入此句";
  }
}

export function clamped(cursor: number, total: number): number {
  return Math.min(Math.max(cursor, 0), Math.max(total - 1, 0));
}

/**
 * A merged Unit is ONE judgment for the author, but the ledger keeps the
 * original granularity (SPEC 9.7): every slice in the unit gets a row.
 * accept-modified's final text belongs to the insertion slice; its partner
 * gets the plain accept that completes the pair.
 */
export type SliceWrite = { sliceId: string; kind: VerdictKindName; finalText: string | null };

export function writesOf(
  unit: Unit,
  kind: VerdictKindName,
  finalText: string | null,
): SliceWrite[] {
  const last = unit.slices.at(-1);
  return unit.slices.map((slice) => {
    const isLast = slice === last;
    return {
      sliceId: slice.id,
      kind: kind === "accept-modified" && !isLast ? "accept" : kind,
      finalText: kind === "accept-modified" && isLast ? finalText : null,
    };
  });
}

/** 键盘 → 意图。原 onKeydown 的 switch 与 if 全部抽到这里，组件只做分派。 */
export type Intent =
  | { kind: "none" }
  | { kind: "move"; delta: number }
  | { kind: "judge"; verdict: VerdictKindName; finalText: string | null }
  | { kind: "open-editor" }
  | { kind: "close-editor" }
  | { kind: "ask-reason" }
  | { kind: "toggle-stage" }
  | { kind: "flip-peer" }
  | { kind: "commit" };

export function intentOf(event: KeyboardEvent, pane: Pane): Intent {
  if (pane.kind === "editing") {
    if (event.key === "Enter" && event.altKey) {
      return { kind: "judge", verdict: "accept-modified", finalText: pane.text };
    }
    if (event.key === "Escape") return { kind: "close-editor" };
    return { kind: "none" };
  }
  if (!event.altKey) return { kind: "none" };
  switch (event.key.toLowerCase()) {
    case "j":
      return { kind: "move", delta: 1 };
    case "k":
      return { kind: "move", delta: -1 };
    case "a":
      return { kind: "judge", verdict: "accept", finalText: null };
    case "x":
      return { kind: "judge", verdict: "reject", finalText: null };
    case "e":
      return { kind: "open-editor" };
    case "r":
      return { kind: "ask-reason" };
    case "s":
      return { kind: "toggle-stage" };
    case "p":
      return { kind: "flip-peer" };
    case "enter":
      return { kind: "commit" };
    default:
      return { kind: "none" };
  }
}

/** 入批 / 出批的下一批次；纯计算，不做门禁。 */
export function restaged(batch: ReadonlySet<string>, verdictIds: readonly string[]): Set<string> {
  const next = new Set(batch);
  const stagedHere = verdictIds.every((id) => next.has(id));
  for (const id of verdictIds) {
    if (stagedHere) next.delete(id);
    else next.add(id);
  }
  return next;
}
