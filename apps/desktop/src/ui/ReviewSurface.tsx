// The review surface (SPEC 9.7): original fixed left, current unit right;
// every judgment writes through on the keypress, not at commit; progress is
// a count, never a percentage. Keyboard is the primary path; the mouse path
// is always visible, never hover-only.
//
// 本文件的分工：上半部（模块顶层）是纯函数与流程编排——判别联合描述状态，
// unitsOf / verdictOf / intentOf 都不碰信号；下半部的组件只读投影、发意图。
import { createMemo, createSignal, type JSX, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import {
  commands,
  type ProposalDto,
  type ReviewSliceDto,
  type ReviewStateDto,
  type VerdictKindName,
  type VerdictRecord,
} from "../generated/bindings.gen";

export type ReviewSurfaceProps = {
  rootId: string;
  path: string;
  onCommitted?: () => void;
  onClosed?: () => void;
};

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
type Session = { kind: "loading" } | { kind: "ready"; proposals: readonly ProposalDto[] };

/** 原 `editingFinal: string | null`：右栏是在看还是在改。 */
type Pane = { kind: "reading" } | { kind: "editing"; text: string };

/** 原 `reasonDraft: string | null`：理由给了没给。 */
type Reason = { kind: "unstated" } | { kind: "stated"; text: string };

/** 原 `competingPeer: boolean`：换看竞争稿，A / B 是两个具名面而不是真假。 */
type Peer = { kind: "a" } | { kind: "b" };

/** 原 `error: string | null`：区分「规矩没走对」与「桥上失败」。 */
type Notice =
  | { kind: "silent" }
  | { kind: "refused"; text: string }
  | { kind: "failed"; text: string };

/** 当前 Unit 相对账本与批次的位置：原 verdictOf/isStaged 两个可空判断的合体。 */
type Standing =
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

function unitsOf(proposals: readonly ProposalDto[]): Unit[] {
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

type Ledger = ReadonlyMap<string, VerdictRecord>;

// Counts are per Unit: a unit is decided when every slice in it has a row
// (SPEC 9.7: the ledger is slice-granular, the progress is unit-granular).
function decidedCount(units: readonly Unit[], ledger: Ledger): number {
  return units.filter((unit) => unit.slices.every((slice) => ledger.has(slice.id))).length;
}

function verdictIdsOf(unit: Unit, ledger: Ledger): string[] {
  return unit.slices
    .map((slice) => ledger.get(slice.id)?.id)
    .filter((id): id is string => id !== undefined);
}

function standingOf(unit: Unit | null, ledger: Ledger, batch: ReadonlySet<string>): Standing {
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

function actionLabel(unit: Unit | null): string {
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

function clamped(cursor: number, total: number): number {
  return Math.min(Math.max(cursor, 0), Math.max(total - 1, 0));
}

/**
 * A merged Unit is ONE judgment for the author, but the ledger keeps the
 * original granularity (SPEC 9.7): every slice in the unit gets a row.
 * accept-modified's final text belongs to the insertion slice; its partner
 * gets the plain accept that completes the pair.
 */
type SliceWrite = { sliceId: string; kind: VerdictKindName; finalText: string | null };

function writesOf(unit: Unit, kind: VerdictKindName, finalText: string | null): SliceWrite[] {
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
type Intent =
  | { kind: "none" }
  | { kind: "move"; delta: number }
  | { kind: "judge"; verdict: VerdictKindName; finalText: string | null }
  | { kind: "open-editor" }
  | { kind: "close-editor" }
  | { kind: "ask-reason" }
  | { kind: "toggle-stage" }
  | { kind: "flip-peer" }
  | { kind: "commit" };

function intentOf(event: KeyboardEvent, pane: Pane): Intent {
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
function restaged(batch: ReadonlySet<string>, verdictIds: readonly string[]): Set<string> {
  const next = new Set(batch);
  const stagedHere = verdictIds.every((id) => next.has(id));
  for (const id of verdictIds) {
    if (stagedHere) next.delete(id);
    else next.add(id);
  }
  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// 流程编排：只吃快照，只吐结果联合。
// ──────────────────────────────────────────────────────────────────────────

type Failure = { kind: "failed"; text: string };

function failure(cause: unknown): Failure {
  return { kind: "failed", text: describe(cause) };
}

type SessionLoad = { kind: "loaded"; state: ReviewStateDto } | Failure;

async function loadSession(rootId: string, path: string): Promise<SessionLoad> {
  try {
    return { kind: "loaded", state: await unwrap(commands.reviewState(rootId, path)) };
  } catch (cause) {
    return failure(cause);
  }
}

type Persisted = { kind: "persisted" } | Failure;

async function persistSession(
  rootId: string,
  path: string,
  cursor: number,
  batch: ReadonlySet<string>,
): Promise<Persisted> {
  try {
    await unwrap(commands.setReviewBatch(rootId, path, cursor, [...batch]));
    return { kind: "persisted" };
  } catch (cause) {
    return failure(cause);
  }
}

type JudgeResult = { kind: "recorded"; records: VerdictRecord[] } | Failure;

async function performJudge(
  rootId: string,
  unit: Unit,
  writes: readonly SliceWrite[],
  reason: Reason,
): Promise<JudgeResult> {
  try {
    const records: VerdictRecord[] = [];
    for (const write of writes) {
      records.push(
        await unwrap(
          commands.recordVerdict(
            rootId,
            unit.proposalId,
            write.sliceId,
            write.kind,
            reason.kind === "stated" ? reason.text : null,
            write.finalText,
          ),
        ),
      );
    }
    return { kind: "recorded", records };
  } catch (cause) {
    return failure(cause);
  }
}

type CommitResult = { kind: "committed" } | Failure;

async function performCommit(rootId: string, path: string): Promise<CommitResult> {
  try {
    await unwrap(commands.commitDecisionBatch(rootId, path));
    return { kind: "committed" };
  } catch (cause) {
    return failure(cause);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 组件：读投影、发意图。
// ──────────────────────────────────────────────────────────────────────────

export function ReviewSurface(props: ReviewSurfaceProps): JSX.Element {
  const [session, setSession] = createSignal<Session>({ kind: "loading" });
  const [cursor, setCursor] = createSignal(0);
  const [batch, setBatch] = createSignal<ReadonlySet<string>>(new Set());
  const [ledger, setLedger] = createSignal<Ledger>(new Map());
  const [pane, setPane] = createSignal<Pane>({ kind: "reading" });
  const [reason, setReason] = createSignal<Reason>({ kind: "unstated" });
  const [peer, setPeer] = createSignal<Peer>({ kind: "a" });
  const [notice, setNotice] = createSignal<Notice>({ kind: "silent" });

  const units = createMemo<Unit[]>(() => {
    const held = session();
    return held.kind === "ready" ? unitsOf(held.proposals) : [];
  });
  const total = createMemo(() => units().length);
  const current = createMemo<Unit | null>(() => units()[cursor()] ?? null);
  const decided = createMemo(() => decidedCount(units(), ledger()));
  const staged = createMemo(() => batch().size);
  const standing = createMemo(() => standingOf(current(), ledger(), batch()));
  /** 判过之后才有的那一行标记：把联合压成 Show 能窄化的一个可空投影。 */
  const mark = createMemo<{ kind: VerdictKindName; staged: boolean } | null>(() => {
    const held = standing();
    if (held.kind === "undecided") return null;
    return { kind: held.verdict.kind, staged: held.kind === "staged" };
  });
  const noticeText = createMemo(() => {
    const held = notice();
    return held.kind === "silent" ? null : held.text;
  });

  const save = async (nextCursor: number, nextBatch: ReadonlySet<string>): Promise<void> => {
    const result = await persistSession(props.rootId, props.path, nextCursor, nextBatch);
    if (result.kind === "failed") setNotice(result);
  };

  const move = async (delta: number): Promise<void> => {
    const next = clamped(cursor() + delta, total());
    if (next === cursor()) return;
    setCursor(next);
    await save(next, batch());
  };

  const judge = async (verdict: VerdictKindName, finalText: string | null): Promise<void> => {
    const unit = current();
    if (unit === null) return;
    const result = await performJudge(
      props.rootId,
      unit,
      writesOf(unit, verdict, finalText),
      reason(),
    );
    if (result.kind === "failed") {
      setNotice(result);
      return;
    }
    const next = new Map(ledger());
    for (const record of result.records) next.set(record.sliceId, record);
    setLedger(next);
    setReason({ kind: "unstated" });
    setPane({ kind: "reading" });
    await save(cursor(), batch());
    window.setTimeout(() => void move(1), 120);
  };

  const toggleStage = async (): Promise<void> => {
    const unit = current();
    if (unit === null) return;
    const verdictIds = verdictIdsOf(unit, ledger());
    if (verdictIds.length < unit.slices.length) {
      setNotice({ kind: "refused", text: "先裁决，再入批。" });
      return;
    }
    const next = restaged(batch(), verdictIds);
    setBatch(next);
    await save(cursor(), next);
  };

  const commit = async (): Promise<void> => {
    if (staged() === 0) {
      setNotice({ kind: "refused", text: "没有入批的裁决。" });
      return;
    }
    const result = await performCommit(props.rootId, props.path);
    if (result.kind === "failed") {
      setNotice(result);
      return;
    }
    props.onCommitted?.();
  };

  const openEditor = (): void => {
    setPane({ kind: "editing", text: current()?.after ?? "" });
  };

  const askReason = (): void => {
    const given = window.prompt("理由（可留空）") ?? "";
    setReason({ kind: "stated", text: given });
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const intent = intentOf(event, pane());
    if (intent.kind === "none") return;
    event.preventDefault();
    switch (intent.kind) {
      case "move":
        void move(intent.delta);
        break;
      case "judge":
        void judge(intent.verdict, intent.finalText);
        break;
      case "open-editor":
        openEditor();
        break;
      case "close-editor":
        setPane({ kind: "reading" });
        break;
      case "ask-reason":
        askReason();
        break;
      case "toggle-stage":
        void toggleStage();
        break;
      case "flip-peer":
        setPeer((held) => (held.kind === "a" ? { kind: "b" } : { kind: "a" }));
        break;
      case "commit":
        void commit();
        break;
    }
  };

  onMount(() => {
    void (async () => {
      const load = await loadSession(props.rootId, props.path);
      if (load.kind === "failed") {
        setNotice(load);
        return;
      }
      setSession({ kind: "ready", proposals: load.state.proposals });
      setCursor(clamped(load.state.cursor, unitsOf(load.state.proposals).length));
      setBatch(new Set(load.state.batch));
      const rows = new Map<string, VerdictRecord>();
      for (const verdict of load.state.verdicts) rows.set(verdict.sliceId, verdict);
      setLedger(rows);
    })();
  });

  return (
    <section class="review-surface" aria-label="提案裁决" tabindex="0" onKeyDown={onKeydown}>
      <header class="review-head">
        <span>
          {decided()}/{total()} 已判 · {staged()} 待合并
        </span>
        <span class="path">{props.path}</span>
        <button type="button" onClick={() => props.onClosed?.()}>
          返回 (Esc)
        </button>
      </header>

      <Show when={noticeText()}>{(text) => <p class="notice">{text()}</p>}</Show>

      <Show when={total() === 0}>
        <div class="empty">这份文档没有待判的提案。</div>
      </Show>

      <Show when={total() > 0 ? current() : null}>
        {(unit) => (
          <div class="review-body">
            <div class="original">
              <h3>原段</h3>
              <p class="text">{unit().before || "（无）"}</p>
            </div>
            <div class="unit">
              <h3>
                {actionLabel(unit())}
                <Show when={unit().competing}>
                  <span class="competing" title="同题竞争">
                    竞争 {peer().kind === "b" ? "B" : "A"}
                  </span>
                </Show>
              </h3>
              <Show
                when={pane().kind === "editing"}
                fallback={<p class="text proposed">{unit().after || "（删除）"}</p>}
              >
                <textarea
                  class="final-editor"
                  rows="4"
                  aria-label="改后接受的最终文本"
                  value={(() => {
                    const held = pane();
                    return held.kind === "editing" ? held.text : "";
                  })()}
                  onInput={(event) => setPane({ kind: "editing", text: event.currentTarget.value })}
                />
              </Show>
              <p class="hint">
                Alt+J/K 移动 · Alt+A {actionLabel(unit())} · Alt+X 拒绝 · Alt+E 改后接受 · Alt+R
                理由 · Alt+S 入批 · Alt+P 换看竞争稿 · Alt+Enter 合并
              </p>
              <Show when={mark()}>
                {(held) => (
                  <p class="verdict-mark">
                    已判:{held().kind}
                    <Show when={held().staged}>
                      <span> · 已入批</span>
                    </Show>
                  </p>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <div class="mouse-row">
        <button
          type="button"
          disabled={current() === null}
          onClick={() => void judge("accept", null)}
        >
          {actionLabel(current())} (Alt+A)
        </button>
        <button
          type="button"
          disabled={current() === null}
          onClick={() => void judge("reject", null)}
        >
          拒绝 (Alt+X)
        </button>
        <button type="button" disabled={current() === null} onClick={openEditor}>
          改后接受 (Alt+E)
        </button>
        <button type="button" disabled={current() === null} onClick={() => void toggleStage()}>
          {standing().kind === "staged" ? "出批" : "入批"} (Alt+S)
        </button>
        <button
          type="button"
          class="primary"
          disabled={staged() === 0}
          onClick={() => void commit()}
        >
          合并 {staged()} 条 (Alt+Enter)
        </button>
      </div>
    </section>
  );
}

export default ReviewSurface;
