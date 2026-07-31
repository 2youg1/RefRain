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
  type ReviewStateDto,
  type VerdictKindName,
  type VerdictRecord,
} from "../generated/bindings.gen";
import {
  actionLabel,
  clamped,
  decidedCount,
  intentOf,
  type Ledger,
  type Notice,
  type Pane,
  type Peer,
  type Reason,
  restaged,
  type Session,
  type SliceWrite,
  standingOf,
  type Unit,
  unitsOf,
  verdictIdsOf,
  writesOf,
} from "../shell/review-verdicts";
import { StaleProposalPanel } from "./StaleProposalPanel";
import { staleProposalNotice } from "./stale-proposal";

export type { Unit } from "../shell/review-verdicts";

export type ReviewSurfaceProps = {
  rootId: string;
  path: string;
  onCommitted?: () => void;
  onClosed?: () => void;
};

// ──────────────────────────────────────────────────────────────────────────
// 流程编排：只吃快照，只吐结果联合。
// ──────────────────────────────────────────────────────────────────────────

/**
 * 一次失败。
 *
 * `stale` 在这里就摊开，而不是留给每个调用点各判一次：只有一处产生 Failure，
 * 所以只有一处需要认识「提案过期长什么样」。调用点看到 `stale` 非空就用它。
 */
type Failure = {
  kind: "failed";
  text: string;
  stale?: Notice & { kind: "stale" };
};

function failure(cause: unknown): Failure {
  const stale = staleProposalNotice(cause);
  if (stale === null) return { kind: "failed", text: describe(cause) };
  return {
    kind: "failed",
    text: stale.headline,
    stale: {
      kind: "stale",
      text: stale.headline,
      frozenText: stale.frozenText,
      steps: stale.steps,
    },
  };
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
  /** 过期通知单独取出来：它不是一句话，要展开成原文与出路。 */
  const staleNotice = createMemo(() => {
    const held = notice();
    return held.kind === "stale" ? held : null;
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
      setNotice(result.stale ?? result);
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

      {/* 提案过期：出示 Agent 当时读到的原文，让作者自己判断。 */}
      <Show when={staleNotice()}>
        {(stale) => <StaleProposalPanel frozenText={stale().frozenText} steps={stale().steps} />}
      </Show>

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
