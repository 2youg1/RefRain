// 派发票据（SPEC 9.6）的领域层：范围 → 要求 → 伙伴 → 份数 → 发出，作者读到的
// 清单，授权的那一次点击，以及手动回收。这里不推导任何 Rust 拥有的事实；每一条
// 都从桥那边取回。
//
// 这一层从组件里搬出来的理由，不是文件太长，而是权威放错了地方：状态原先由组件
// 的 store 持有，二十五处 setModel 散落在事件回调里，于是「派发到哪一步了」这件
// 事没有单一的说法，也无法在没有浏览器的情况下问一句。现在它归 DispatchSession。
//
// framework-free：不引 solid-js，不碰 DOM。
import { unwrap } from "../bridge";
import {
  type AgentReadingDto,
  type AuthorizeDispatchRequest,
  type BlockDto,
  type CarryMode,
  type CollectOutcomeDto,
  commands,
  type DispatchPreviewDto,
  type DocumentRow,
  type HostStateDto,
  type MaterialDraftRow_Serialize,
  type RunDto,
  type TaskDto,
} from "../generated/bindings.gen";
import { type Activity, type DescribeError, Session } from "./session";

export type DispatchMaterial = { path: string; label: string };

// ──────────────────────────────────────────────────────────────────────────
// 状态：一律用判别联合，不用一堆互相矛盾的 boolean。
// ──────────────────────────────────────────────────────────────────────────

/** 清单展开与否：原 `showRequest: boolean`，且只在 previewing 里才有意义。 */
export type Reveal = { kind: "manifest" } | { kind: "request" };

/**
 * 票据的三个阶段。preview 与 taskId 只在 previewing 里存在，
 * 因此原来的 `preview: DispatchPreviewDto | null` / `taskId: string | null`
 * 不再是独立可空字段——不可能再出现「previewing 但没有清单」。
 */
export type Phase =
  | { kind: "editing" }
  | { kind: "previewing"; taskId: string; preview: DispatchPreviewDto; reveal: Reveal }
  | { kind: "dispatched" };

/**
 * 这个界面能忙的七件事。名字进了 Activity<Operation>，于是「正在忙」说得出
 * 正在忙什么——七个按钮里该灰哪一个，不必再靠第二个布尔量去猜。
 */
export type DispatchOperation =
  | "load"
  | "send"
  | "authorize"
  | "collect"
  | "retry"
  | "cancel"
  | "save-draft"
  | "dismiss-draft";

/** 原 `editingDraft: string | null` + `editedBody: string` 两个字段的合并。 */
export type DraftEdit = { kind: "closed" } | { kind: "open"; draftId: string; body: string };

/** 原 `host: HostStateDto | null`：未读过 host 与「读到空 host」是两件事。 */
export type Journal = { kind: "unread" } | { kind: "read"; host: HostStateDto };

export type AgentChoice = { id: string; label: string };

export type Copies = 1 | 2 | 3;

export type DispatchModel = {
  selected: readonly string[];
  materialsSelected: readonly string[];
  prompt: string;
  agentId: string | null;
  agents: readonly AgentChoice[];
  copies: Copies;
  carry: CarryMode;
  phase: Phase;
  journal: Journal;
  drafts: readonly MaterialDraftRow_Serialize[];
  ledger: readonly AgentReadingDto[];
  draftEdit: DraftEdit;
};

function initialModel(): DispatchModel {
  return {
    selected: [],
    materialsSelected: [],
    prompt: "",
    agentId: null,
    agents: [],
    copies: 1,
    carry: "diff",
    phase: { kind: "editing" },
    journal: { kind: "unread" },
    drafts: [],
    ledger: [],
    draftEdit: { kind: "closed" },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 纯函数：选择、投影、标签。
// ──────────────────────────────────────────────────────────────────────────

function toggled(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((held) => held !== id) : [...ids, id];
}

function unioned(ids: readonly string[], added: readonly string[]): readonly string[] {
  const next = [...ids];
  for (const id of added) if (!next.includes(id)) next.push(id);
  return next;
}

/** Shift-click 走过的整段：原 template 的 touchRow 区间分支，抽成纯函数。 */
function spanIds(blocks: readonly BlockDto[], from: number, to: number): readonly string[] {
  const [low, high] = [Math.min(from, to), Math.max(from, to)];
  const out: string[] = [];
  for (let i = low; i <= high; i += 1) {
    const entry = blocks[i];
    if (entry !== undefined) out.push(entry.id);
  }
  return out;
}

function scopeIdsOf(blocks: readonly BlockDto[], selected: readonly string[]): string[] {
  return blocks.filter((block) => selected.includes(block.id)).map((block) => block.id);
}

function materialPathsOf(
  materials: readonly DispatchMaterial[],
  picked: readonly string[],
): string[] {
  return materials
    .filter((material) => picked.includes(material.path))
    .map((material) => material.path);
}

export type Cells = {
  scope: string;
  requirement: string;
  agent: string;
  range: string;
  ready: boolean;
};

// The five cells (SPEC 9.6): each shows its value when met, — when not, and
// only the first blocker speaks.
function cellsOf(model: DispatchModel): Cells {
  const scope = model.selected.length;
  const requirement = model.prompt.trim().length;
  const agent = model.agents.find((candidate) => candidate.id === model.agentId) ?? null;
  return {
    scope: scope > 0 ? `${scope} 块` : "—",
    requirement: requirement > 0 ? `${requirement} 字` : "—",
    agent: agent ? agent.label : "—",
    range: scope > 0 ? `所选 ${scope} 块` : "—",
    ready: scope > 0 && requirement > 0 && agent !== null,
  };
}

function runsOf(journal: Journal, path: string): RunDto[] {
  if (journal.kind === "unread") return [];
  const taskIds = new Set(
    journal.host.tasks.filter((task) => task.document === path).map((task) => task.id),
  );
  return journal.host.runs.filter((run) => taskIds.has(run.taskId));
}

// The ticket's top hint (C12): what the picked agent has read of this
// document, and whether the manuscript has moved since.
function readingOf(
  ledger: readonly AgentReadingDto[],
  agentId: string | null,
  path: string,
): AgentReadingDto | null {
  return ledger.find((row) => row.agentId === agentId && row.document === path) ?? null;
}

const IN_FLIGHT: readonly string[] = ["authorized", "launching", "dispatched"];

function settling(journal: Journal): boolean {
  return (
    journal.kind === "read" && journal.host.runs.some((run) => IN_FLIGHT.includes(run.progress))
  );
}

export function editingDraftId(edit: DraftEdit): string | null {
  return edit.kind === "open" ? edit.draftId : null;
}

// ──────────────────────────────────────────────────────────────────────────
// 流程编排：只吃快照，只吐结果联合。没有一处触碰信号或 store。
// ──────────────────────────────────────────────────────────────────────────

/** 发一次派发所需的全部输入，从 model + props 压平成一个快照。 */
type Ticket = {
  rootId: string;
  path: string;
  scopeIds: string[];
  materialPaths: string[];
  prompt: string;
  agentId: string;
  carry: CarryMode;
};

function ticketOf(context: DispatchContext, model: DispatchModel, agentId: string): Ticket {
  return {
    rootId: context.rootId,
    path: context.path,
    scopeIds: scopeIdsOf(context.blocks, model.selected),
    materialPaths: materialPathsOf(context.materials, model.materialsSelected),
    prompt: model.prompt.trim(),
    agentId,
    carry: model.carry,
  };
}

function authorizeRequestOf(
  ticket: Ticket,
  taskId: string,
  clickedDigest: string,
  newAgents: string[],
  retryRunIds: string[],
): AuthorizeDispatchRequest {
  return {
    rootId: ticket.rootId,
    taskId,
    path: ticket.path,
    blockIds: ticket.scopeIds,
    materialPaths: ticket.materialPaths,
    prompt: ticket.prompt,
    clickedDigest,
    newAgents,
    retryRunIds,
    agentId: ticket.agentId,
    carry: ticket.carry,
  };
}

/**
 * 这个 session 会过桥的十一件事。
 *
 * 一个接口而不是十一个自由函数：测试要换掉的是「与后端说话」这整件事，不是逐个
 * 打桩；而把它们摆在一起，也让人一眼看得出这个界面到底动了后端多少东西。
 */
export interface DispatchGateway {
  hostState(rootId: string): Promise<HostStateDto>;
  listMaterialDrafts(rootId: string): Promise<MaterialDraftRow_Serialize[]>;
  agentReadingLedger(rootId: string): Promise<AgentReadingDto[]>;
  listAgents(): Promise<{ id: string; name: string; channel: string }[]>;
  l0FileChannelAgent(): Promise<string>;
  draftReviewTask(rootId: string, path: string, prompt: string): Promise<TaskDto>;
  previewDispatch(ticket: Ticket): Promise<DispatchPreviewDto>;
  authorizeDispatch(request: AuthorizeDispatchRequest): Promise<RunDto[]>;
  launchRun(rootId: string, runId: string): Promise<unknown>;
  collectAttempt(rootId: string, runId: string): Promise<CollectOutcomeDto>;
  retryRun(rootId: string, runId: string): Promise<RunDto>;
  cancelRun(rootId: string, runId: string): Promise<unknown>;
  commitMaterialAction(
    rootId: string,
    draftId: string,
    body: string | null,
    dismiss: boolean,
  ): Promise<DocumentRow | null>;
}

export const browserDispatchGateway: DispatchGateway = {
  hostState: (rootId) => unwrap(commands.hostState(rootId)),
  listMaterialDrafts: (rootId) => unwrap(commands.listMaterialDrafts(rootId)),
  agentReadingLedger: (rootId) => unwrap(commands.agentReadingLedger(rootId)),
  listAgents: () => commands.listAgents(),
  l0FileChannelAgent: () => commands.l0FileChannelAgent(),
  draftReviewTask: (rootId, path, prompt) => unwrap(commands.draftReviewTask(rootId, path, prompt)),
  previewDispatch: (ticket) =>
    unwrap(
      commands.previewDispatch(
        ticket.rootId,
        ticket.path,
        ticket.scopeIds,
        ticket.materialPaths,
        ticket.prompt,
        ticket.agentId,
        ticket.carry,
      ),
    ),
  authorizeDispatch: (request) => unwrap(commands.authorizeDispatch(request)),
  launchRun: (rootId, runId) => unwrap(commands.launchRun(rootId, runId)),
  collectAttempt: (rootId, runId) => unwrap(commands.collectAttempt(rootId, runId)),
  retryRun: (rootId, runId) => unwrap(commands.retryRun(rootId, runId)),
  cancelRun: (rootId, runId) => unwrap(commands.cancelRun(rootId, runId)),
  commitMaterialAction: (rootId, draftId, body, dismiss) =>
    unwrap(commands.commitMaterialAction(rootId, draftId, body, dismiss)),
};

/** 收取结果 → 要说的话 + 要不要向上报数。分支只此一处。 */
/**
 * 一次收取的两种结局：拿到了什么，以及要不要告诉外面有新提案。
 *
 * 「等待中」与「失败」都不是新提案，所以 proposals 为 null；而「失败」必须走
 * 失败那一支，不能只是一句措辞不同的告知——两者在界面上是不同的颜色与语气。
 */
function collectReport(
  outcome: CollectOutcomeDto,
): { kind: "told"; text: string; proposals: number | null } | { kind: "failed"; text: string } {
  if (outcome.kind === "waiting") return { kind: "told", text: "未回", proposals: null };
  if (outcome.kind === "completed") {
    const got = outcome.value;
    return {
      kind: "told",
      text:
        got.drafts > 0
          ? `已收 · ${got.proposals} 提案 · ${got.drafts} 草稿`
          : `已收 · ${got.proposals} 提案`,
      proposals: got.proposals,
    };
  }
  return { kind: "failed", text: `失败 · ${outcome.value.code}` };
}

/** 发出之后那一句：并行几路，或落到哪个工作目录。 */
function dispatchedNotice(runs: readonly RunDto[]): string {
  return runs.length > 1
    ? `已发出 · 并行 ×${runs.length}`
    : `已发出 → ${runs[0]?.workspace ?? "runs/"}`;
}

// ──────────────────────────────────────────────────────────────────────────
// 会话：状态的唯一权威，十条意图的唯一入口。
// ──────────────────────────────────────────────────────────────────────────

/** 这张票据是针对哪份稿子的哪些块——由外面给定，session 期间不变。 */
export interface DispatchContext {
  readonly rootId: string;
  readonly path: string;
  readonly blocks: readonly BlockDto[];
  readonly materials: readonly DispatchMaterial[];
}

/** 派发完成后要告诉外面的事。session 不认识组件，只认识这三件事。 */
export interface DispatchOutcomes {
  collected(count: number): void;
  materialSaved(row: DocumentRow): void;
}

export interface DispatchView {
  readonly model: DispatchModel;
  /**
   * 只在 previewing 那一支里才存在的东西，已经取出来了。
   *
   * 让界面自己写 `phase.kind === "previewing" ? phase : null` 是把收窄这件事
   * 交给一个每次调用都返回新引用的读法，类型上站不住；在这里取一次，界面拿到
   * 的就是「有清单」或「没有」。
   */
  readonly manifest: {
    readonly taskId: string;
    readonly preview: DispatchPreviewDto;
    readonly reveal: Reveal;
  } | null;
  /** 正在改的那份草稿的正文；没有在改就是 null。 */
  readonly draftBody: { readonly draftId: string; readonly body: string } | null;
  readonly activity: Activity<DispatchOperation>;
  readonly cells: Cells;
  readonly runs: readonly RunDto[];
  readonly reading: AgentReadingDto | null;
  readonly settling: boolean;
}

export class DispatchSession extends Session<DispatchOperation> {
  #model: DispatchModel = initialModel();
  /** Shift-click 的锚点。属于「手上一次点了哪行」，不是票据的内容。 */
  #lastTouched = -1;

  constructor(
    private readonly gateway: DispatchGateway,
    private context: DispatchContext,
    private readonly outcomes: DispatchOutcomes,
    private readonly describe: DescribeError,
  ) {
    super();
  }

  protected describeError(error: unknown): string {
    // 领域层自己写好的话原样呈现；只有真正的异常才交给通用描述。
    return error instanceof Reported ? error.message : this.describe(error);
  }

  view(): DispatchView {
    const phase = this.#model.phase;
    const edit = this.#model.draftEdit;
    return {
      model: this.#model,
      manifest: phase.kind === "previewing" ? phase : null,
      draftBody: edit.kind === "open" ? edit : null,
      activity: this.activity,
      cells: cellsOf(this.#model),
      runs: runsOf(this.#model.journal, this.context.path),
      reading: readingOf(this.#model.ledger, this.#model.agentId, this.context.path),
      settling: settling(this.#model.journal),
    };
  }

  /** 稿子换了：票据的对象变了，已选的块 id 不再指向任何东西。 */
  retarget(context: DispatchContext): void {
    this.context = context;
    this.#patch({ selected: [], phase: { kind: "editing" } });
    this.#lastTouched = -1;
  }

  // —— 编辑票据：不跨桥，不占锁 ——

  seed(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.#patch({ selected: unioned(this.#model.selected, ids) });
  }

  proposePrompt(text: string): void {
    this.#patch({ prompt: text });
  }

  chooseAgent(agentId: string | null): void {
    this.#patch({ agentId });
  }

  chooseCopies(copies: Copies): void {
    this.#patch({ copies });
  }

  chooseCarry(carry: CarryMode): void {
    this.#patch({ carry });
  }

  /** 整篇。全选与逐块选是同一件事的两个入口，都只写 selected 这一处。 */
  selectWholeDocument(): void {
    this.#patch({ selected: this.context.blocks.map((block) => block.id) });
  }

  toggleMaterial(path: string): void {
    this.#patch({ materialsSelected: toggled(this.#model.materialsSelected, path) });
  }

  /**
   * 点一行。Shift 走区间——一章上百块时，这是唯一还能用手选完的方式。
   */
  touchRow(index: number, shiftKey: boolean): void {
    const block = this.context.blocks[index];
    if (block === undefined) return;
    const held = this.#model.selected;
    const spanning = shiftKey && this.#lastTouched >= 0 && this.#lastTouched !== index;
    this.#patch({
      selected: spanning
        ? unioned(held, spanIds(this.context.blocks, this.#lastTouched, index))
        : toggled(held, block.id),
    });
    this.#lastTouched = index;
  }

  toggleDraftEdit(draft: MaterialDraftRow_Serialize): void {
    this.#patch({
      draftEdit:
        editingDraftId(this.#model.draftEdit) === draft.id
          ? { kind: "closed" }
          : { kind: "open", draftId: draft.id, body: draft.body },
    });
  }

  editDraftBody(body: string): void {
    const edit = this.#model.draftEdit;
    if (edit.kind !== "open") return;
    this.#patch({ draftEdit: { ...edit, body } });
  }

  /** 清单与原文两面。只在 previewing 里有意义，别处点它没有含义。 */
  toggleReveal(): void {
    const phase = this.#model.phase;
    if (phase.kind !== "previewing") return;
    this.#patch({
      phase: {
        ...phase,
        reveal: phase.reveal.kind === "request" ? { kind: "manifest" } : { kind: "request" },
      },
    });
  }

  /** 写完一单，重新开一单。已发出的那单留在日志里，不受影响。 */
  newTask(): void {
    this.#patch({ phase: { kind: "editing" }, selected: [], prompt: "" });
    this.dismissNotice();
  }

  // —— 跨桥的十件事：每件都占锁，锁只由底座实现 ——

  /**
   * 开场：把可选的写作伙伴读进来，并替作者选中第一个。
   *
   * 默认选中是有意的——票据的五格里「伙伴」一格若空着，发出按钮就一直是灰的，
   * 而绝大多数作者只连了一个伙伴。让他们少点一次。
   */
  start(): Promise<void> {
    return this.exclusive("load", async () => {
      // 只有具名的写作伙伴进得了票据；一台机器连接不是 Agent，手动往返始终
      // 作为显式兜底留在末尾。
      const agents: AgentChoice[] = (await this.gateway.listAgents()).map((agent) => ({
        id: agent.id,
        label: `${agent.name} · ${agent.channel}`,
      }));
      agents.push({ id: await this.gateway.l0FileChannelAgent(), label: "手动往返" });
      this.#patch({ agents, agentId: this.#model.agentId ?? agents[0]?.id ?? null });
      await this.#reload();
      return null;
    });
  }

  refresh(): Promise<void> {
    return this.exclusive("load", async () => {
      await this.#reload();
      return null;
    });
  }

  /**
   * 在途的单子会在别处落地，所以要回头看。
   *
   * 只在真有在途单子时才过桥；没有就什么都不做，让一份摊开却安静的稿子不产生
   * 任何后台流量。返回停表的函数。
   */
  watchInFlight(every: number, schedule: (ms: number, task: () => void) => () => void): () => void {
    return schedule(every, () => {
      if (settling(this.#model.journal)) void this.refresh();
    });
  }

  send(): Promise<void> {
    return this.exclusive("send", async () => {
      const agentId = this.#model.agentId;
      if (!cellsOf(this.#model).ready || agentId === null) return null;
      const ticket = ticketOf(this.context, this.#model, agentId);
      const task = await this.gateway.draftReviewTask(ticket.rootId, ticket.path, ticket.prompt);
      const preview = await this.gateway.previewDispatch(ticket);
      this.#patch({
        phase: { kind: "previewing", taskId: task.id, preview, reveal: { kind: "manifest" } },
      });
      return null;
    });
  }

  authorize(): Promise<void> {
    return this.exclusive("authorize", async () => {
      const phase = this.#model.phase;
      const agentId = this.#model.agentId;
      if (phase.kind !== "previewing" || agentId === null) return null;
      const ticket = ticketOf(this.context, this.#model, agentId);
      const runs = await this.gateway.authorizeDispatch(
        authorizeRequestOf(
          ticket,
          phase.taskId,
          phase.preview.digest,
          Array.from({ length: this.#model.copies }, () => ticket.agentId),
          [],
        ),
      );
      // 授权与启动是两步：授权把单子记下来，启动才真的把它交出去。分开做，
      // 中途失败时账上留下的是「已授权未启动」，而不是一个说不清的状态。
      for (const run of runs) await this.gateway.launchRun(ticket.rootId, run.id);
      this.#patch({ phase: { kind: "dispatched" } });
      await this.#reload();
      return dispatchedNotice(runs);
    });
  }

  collect(run: RunDto): Promise<void> {
    return this.exclusive("collect", async () => {
      const outcome = await this.gateway.collectAttempt(this.context.rootId, run.id);
      const report = collectReport(outcome);
      if (report.kind === "failed") {
        await this.#reload();
        throw new Reported(report.text);
      }
      if (report.proposals !== null) this.outcomes.collected(report.proposals);
      await this.#reload();
      return report.text;
    });
  }

  retry(run: RunDto): Promise<void> {
    return this.exclusive("retry", async () => {
      const agentId = this.#model.agentId;
      if (agentId === null) return null;
      const ticket = ticketOf(this.context, this.#model, agentId);
      const queued = await this.gateway.retryRun(ticket.rootId, run.id);
      // 重发要重新过一遍清单：稿子可能已经变了，照着旧摘要发出去就不是作者
      // 当初读过的那一份。
      const again = await this.gateway.previewDispatch(ticket);
      await this.gateway.authorizeDispatch(
        authorizeRequestOf(ticket, queued.taskId, again.digest, [], [queued.id]),
      );
      await this.gateway.launchRun(ticket.rootId, queued.id);
      await this.#reload();
      return "已重发";
    });
  }

  cancel(run: RunDto): Promise<void> {
    return this.exclusive("cancel", async () => {
      await this.gateway.cancelRun(this.context.rootId, run.id);
      await this.#reload();
      return null;
    });
  }

  saveDraft(draft: MaterialDraftRow_Serialize): Promise<void> {
    return this.exclusive("save-draft", async () => {
      const edit = this.#model.draftEdit;
      const body = edit.kind === "open" && edit.draftId === draft.id ? edit.body : null;
      const row = await this.gateway.commitMaterialAction(
        this.context.rootId,
        draft.id,
        body,
        false,
      );
      if (row !== null) this.outcomes.materialSaved(row);
      this.#patch({ draftEdit: { kind: "closed" } });
      await this.#reload();
      return "已存";
    });
  }

  dismissDraft(draft: MaterialDraftRow_Serialize): Promise<void> {
    return this.exclusive("dismiss-draft", async () => {
      await this.gateway.commitMaterialAction(this.context.rootId, draft.id, null, true);
      if (editingDraftId(this.#model.draftEdit) === draft.id) {
        this.#patch({ draftEdit: { kind: "closed" } });
      }
      await this.#reload();
      return "已退";
    });
  }

  /** 读日志：主机状态、草稿、阅读账本三样一起换，避免半新半旧的一帧。 */
  async #reload(): Promise<void> {
    const rootId = this.context.rootId;
    // 三样一起取、一起换：半新半旧的一帧会让作者看到一条已经收过的单子还挂在
    // 「未回」上。
    const [host, drafts, ledger] = await Promise.all([
      this.gateway.hostState(rootId),
      this.gateway.listMaterialDrafts(rootId),
      this.gateway.agentReadingLedger(rootId),
    ]);
    this.#patch({ journal: { kind: "read", host }, drafts, ledger });
  }

  /**
   * 换一个新的 model 对象再广播。
   *
   * 整体替换而不是原地改字段：读到的人只要比较引用就知道要不要重算，也不可能
   * 读到改了一半的中间态。
   */
  #patch(changes: Partial<DispatchModel>): void {
    this.#model = { ...this.#model, ...changes };
    this.emit();
  }
}

/**
 * 一条已经写给作者看的话。
 *
 * 领域层内部用抛出把失败一路带到锁那里，由锁统一落到 failed 上；describeError
 * 认得它就原样呈现，不会在作者的措辞外面再套一层 "Error: "。
 */
export class Reported extends Error {}
