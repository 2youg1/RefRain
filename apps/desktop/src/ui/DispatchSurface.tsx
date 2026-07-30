// 派发界面（SPEC 9.6）：读 DispatchSession 的投影，把点击译成意图。
//
// 这里没有业务分支，没有跨桥调用，也没有「先怎样再怎样」的次序——那些都在
// shell/dispatch-session.ts 里，并且在没有浏览器的情况下被测试。这个文件只回答
// 一个问题：当下这份 view 应该长什么样。
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { describe } from "../bridge";
import type { BlockDto, CarryMode, DocumentRow } from "../generated/bindings.gen";
import {
  browserDispatchGateway,
  type Copies,
  type DispatchMaterial,
  DispatchSession,
  editingDraftId,
} from "../shell/dispatch-session";
import { runStatusLabel, terminal, tokenLabel } from "../shell/dispatch-wording";

export type { DispatchMaterial } from "../shell/dispatch-session";

export type DispatchSurfaceProps = {
  rootId: string;
  path: string;
  blocks: BlockDto[];
  materials: DispatchMaterial[];
  /** Block ids planted by the editor's context menu (派发此段 / 加入派发). */
  seed?: string[];
  /** A persisted author-comment packet converted into a normal dispatch ticket. */
  initialPrompt?: string;
  onCollected?: (count: number) => void;
  onMaterialSaved?: (row: DocumentRow) => void;
  onClosed?: () => void;
};

/** 在途单子的回看间隔。够快让作者察觉，够慢不至于让一份摊开的稿子一直在过桥。 */
const POLL_INTERVAL_MS = 2_500;

export function DispatchSurface(props: DispatchSurfaceProps): JSX.Element {
  const session = new DispatchSession(
    browserDispatchGateway,
    {
      rootId: props.rootId,
      path: props.path,
      blocks: props.blocks,
      materials: props.materials,
    },
    {
      collected: (count) => props.onCollected?.(count),
      materialSaved: (row) => props.onMaterialSaved?.(row),
    },
    describe,
  );

  // 一个信号承载整份 view。session 每次广播换一个引用，Solid 据此重算读到它的部分。
  const [view, setView] = createSignal(session.view());
  onCleanup(session.onChanged(() => setView(session.view())));

  const model = () => view().model;
  const cells = () => view().cells;
  const runs = () => view().runs;
  const reading = () => view().reading;
  const manifest = () => view().manifest;
  const draftBody = () => view().draftBody;
  const busy = () => view().activity.kind === "working";
  const noticeText = createMemo<string | null>(() => {
    const activity = view().activity;
    return activity.kind === "reported" || activity.kind === "failed" ? activity.text : null;
  });

  // 稿子换了：票据换对象，已选的块 id 不再指向任何东西。
  createEffect(() => {
    session.retarget({
      rootId: props.rootId,
      path: props.path,
      blocks: props.blocks,
      materials: props.materials,
    });
  });

  createEffect(() => {
    const seed = props.seed;
    if (seed !== undefined) session.seed(seed);
  });

  createEffect(() => {
    const initialPrompt = props.initialPrompt;
    if (initialPrompt !== undefined) session.proposePrompt(initialPrompt);
  });

  onMount(() => {
    void session.start();
    onCleanup(
      session.watchInFlight(POLL_INTERVAL_MS, (ms, task) => {
        const handle = window.setInterval(task, ms);
        return () => window.clearInterval(handle);
      }),
    );
  });

  return (
    <section class="dispatch" data-quarter="agent" aria-label="派发">
      <header class="ticket">
        <div class="cell">
          <span class="name">段落</span>
          <span class="value">{cells().scope}</span>
        </div>
        <div class="cell">
          <span class="name">要求</span>
          <span class="value">{cells().requirement}</span>
        </div>
        <div class="cell">
          <span class="name">委托</span>
          <span class="value">{cells().agent}</span>
        </div>
        <div class="cell">
          <span class="name">范围</span>
          <span class="value">{cells().range}</span>
        </div>
        <div class="cell send">
          <button
            class="dispatch-send"
            type="button"
            disabled={!cells().ready || busy()}
            onClick={() => void session.send()}
          >
            送出
          </button>
        </div>
      </header>
      <Show when={noticeText()}>{(text) => <p class="notice">{text()}</p>}</Show>

      <Show when={model().phase.kind === "editing"}>
        <div class="blocks">
          <div class="blocks-head">
            <span>段落</span>
            <button
              type="button"
              class="dispatch-whole"
              onClick={() => session.selectWholeDocument()}
            >
              整章
            </button>
          </div>
          <For each={props.blocks}>
            {(block, index) => (
              <label class="block-row">
                <input
                  type="checkbox"
                  checked={model().selected.includes(block.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    session.touchRow(index(), event.shiftKey);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    session.touchRow(index(), event.shiftKey);
                  }}
                />
                <span class="ordinal">b{index() + 1}</span>
                <span class="peek">{block.text.slice(0, 20)}</span>
                <span class="count">{block.text.length} 字</span>
              </label>
            )}
          </For>
        </div>
        <Show when={props.materials.length > 0}>
          <div class="blocks">
            <div class="blocks-head">
              <span>资料</span>
            </div>
            <For each={props.materials}>
              {(material) => (
                <label class="material-row">
                  <input
                    type="checkbox"
                    checked={model().materialsSelected.includes(material.path)}
                    onChange={() => session.toggleMaterial(material.path)}
                  />
                  <span class="peek">{material.label}</span>
                </label>
              )}
            </For>
          </div>
        </Show>
        <Show when={model().agents.length > 0}>
          <div class="agent-row">
            <Show when={model().agents.length > 1}>
              <select
                class="dispatch-agent"
                value={model().agentId ?? ""}
                onChange={(event) => session.chooseAgent(event.currentTarget.value)}
              >
                <For each={model().agents}>
                  {(agent) => <option value={agent.id}>{agent.label}</option>}
                </For>
              </select>
            </Show>
            <span class="copies">
              <select
                class="dispatch-copies"
                aria-label="份数"
                value={String(model().copies)}
                onChange={(event) =>
                  session.chooseCopies(Number.parseInt(event.currentTarget.value, 10) as Copies)
                }
              >
                <option value="1">×1</option>
                <option value="2">并行 ×2</option>
                <option value="3">并行 ×3</option>
              </select>
            </span>
            <select
              class="dispatch-carry"
              aria-label="档位"
              value={model().carry}
              onChange={(event) => session.chooseCarry(event.currentTarget.value as CarryMode)}
            >
              <option value="diff">增量</option>
              <option value="full">全文</option>
              <option value="none">不带</option>
            </select>
            <Show when={reading()}>
              {(row) => (
                <span class="reading">
                  {row().rounds} 轮 · {row().stale ? "落后" : "同步"}
                </span>
              )}
            </Show>
          </div>
        </Show>
        <textarea
          class="dispatch-prompt"
          rows="4"
          placeholder="要求"
          value={model().prompt}
          onInput={(event) => session.proposePrompt(event.currentTarget.value)}
        />
      </Show>

      <Show when={model().drafts.length > 0}>
        <div class="blocks">
          <div class="blocks-head">
            <span>草稿</span>
          </div>
          <For each={model().drafts}>
            {(draft) => (
              <div class="draft-row">
                <div class="draft-line">
                  <span class="peek">{draft.title}</span>
                  <button
                    type="button"
                    class="draft-save"
                    disabled={busy()}
                    onClick={() => session.saveDraft(draft)}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    class="draft-edit"
                    disabled={busy()}
                    onClick={() => session.toggleDraftEdit(draft)}
                  >
                    改
                  </button>
                  <button
                    type="button"
                    class="draft-dismiss"
                    disabled={busy()}
                    onClick={() => session.dismissDraft(draft)}
                  >
                    退回
                  </button>
                </div>
                <Show
                  when={editingDraftId(model().draftEdit) === draft.id}
                  fallback={<span class="peek draft-peek">{draft.body.slice(0, 40)}</span>}
                >
                  <textarea
                    class="draft-body"
                    rows="6"
                    value={draftBody()?.body ?? ""}
                    onInput={(event) => session.editDraftBody(event.currentTarget.value)}
                  />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={manifest()}>
        {(phase) => (
          <div class="manifest">
            <p class="manifest-title">清单 · {phase().preview.digest.slice(0, 12)}</p>
            <For each={phase().preview.manifest}>
              {(entry) => (
                <div class="manifest-row">
                  <span class="section">
                    {entry.section} · {entry.source}
                  </span>
                  <span class="bytes">{entry.bytes} B</span>
                  <span class="tokens">{tokenLabel(entry.tokens)}</span>
                </div>
              )}
            </For>
            <button type="button" class="dispatch-expand" onClick={() => session.toggleReveal()}>
              {phase().reveal.kind === "request" ? "收" : "原文"}
            </button>
            <Show when={phase().reveal.kind === "request"}>
              <pre class="request-md">{phase().preview.requestMd}</pre>
            </Show>
            <div class="actions">
              <button
                class="primary dispatch-authorize"
                type="button"
                disabled={busy()}
                onClick={() => void session.authorize()}
              >
                授权
              </button>
              <button type="button" disabled={busy()} onClick={() => session.newTask()}>
                返回
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={runs().length > 0}>
        <div class="runs">
          <For each={runs()}>
            {(run) => (
              <div class="run-row">
                <span class="status">{runStatusLabel(run)}</span>
                <Show when={run.workspace}>
                  <code class="workspace">{run.workspace}</code>
                </Show>
                <span class="run-actions">
                  <Show when={run.progress === "dispatched"}>
                    <button
                      class="dispatch-collect"
                      type="button"
                      disabled={busy()}
                      onClick={() => session.collect(run)}
                    >
                      收取
                    </button>
                  </Show>
                  <Show when={run.progress === "failed" || run.progress === "cancelled"}>
                    <button
                      class="dispatch-retry"
                      type="button"
                      disabled={busy()}
                      onClick={() => session.retry(run)}
                    >
                      重试
                    </button>
                  </Show>
                  <Show when={!terminal(run)}>
                    <button type="button" disabled={busy()} onClick={() => session.cancel(run)}>
                      取消
                    </button>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <button type="button" class="dispatch-close" onClick={() => props.onClosed?.()}>
        收起
      </button>
      <Show when={model().phase.kind === "dispatched"}>
        <button type="button" class="dispatch-new" onClick={() => session.newTask()}>
          再发
        </button>
      </Show>
    </section>
  );
}
