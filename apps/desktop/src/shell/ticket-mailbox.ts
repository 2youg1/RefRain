/**
 * 发送信箱（SPEC 9.6 的收件面）：三格状态机的唯一权威。
 *
 * - 待发送：起了草还没交出去的单（Task 停在 draft）。
 * - 已回复：提案到了、还没有一句裁决的单。徽标计数就是它。
 * - 已裁决：判过的单。还在批次里的可以回溯——退回已回复，批次与账本同时放手。
 *
 * 数据来自 host_state（tasks）与 review_state（proposals/verdicts/batch），
 * 信箱只做投影，不另存一份事实。
 *
 * **次序、Pin、弃置的权威在 Rust**（`mailbox_standing`）。它们此前只活在这里
 * 的一个 `#order` 数组里，关窗即失：次序丢了是麻烦，而 Pin 与弃置是作者的
 * 显式判断——「这一单必须留在眼前」「我放弃这批提案」与裁决同属一类事实，
 * 不能由一个面板的内存来记。弃置只做软删除：提案与账本一行不动（INV-4）。
 *
 * 侧栏那一格是**缩略**：只显示前 `MAILBOX_PEEK` 条，其余折进管理页。上界在
 * 这里而不在面板里，因为「一格显示多少」决定了侧栏有没有上界，而底部导航
 * 能不能留在屏内取决于它。
 */

import { describe, unwrap } from "../bridge";
import type {
  FileStamp_Serialize,
  HostStateDto,
  MailboxStanding_Serialize,
  ProposalDto,
  ReviewStateDto_Serialize,
  TextTransitionDto,
} from "../generated/bindings.gen";
import { commands } from "../generated/bindings.gen";
import { writesOf } from "./review-verdicts";
import { Broadcast } from "./session";

/** 生产 gateway：信箱的全部事实都过桥自 Rust。 */
export const browserMailboxGateway: TicketMailboxGateway = {
  hostState: (rootId) => unwrap(commands.hostState(rootId)),
  reviewState: (rootId, path) => unwrap(commands.reviewState(rootId, path)),
  standings: (rootId) => unwrap(commands.mailboxStandings(rootId)),
  setOrder: async (rootId, box, entryIds) => {
    await unwrap(commands.setMailboxOrder(rootId, box, entryIds));
  },
  setPinned: async (rootId, box, entryId, pinned) => {
    await unwrap(commands.setMailboxPinned(rootId, box, entryId, pinned));
  },
  discard: async (rootId, box, entryIds) => {
    await unwrap(commands.discardMailboxEntries(rootId, box, entryIds));
  },
  restore: (rootId, entryId) => unwrap(commands.restoreMailboxEntry(rootId, entryId)),
  countermand: (rootId, path, proposalIds) =>
    unwrap(commands.countermandProposals(rootId, path, proposalIds)),
  revertVerdicts: (rootId, path, verdictIds) =>
    unwrap(commands.revertVerdicts(rootId, path, verdictIds)),
  recordVerdict: (rootId, proposalId, sliceId, kind, reason, finalText) =>
    unwrap(commands.recordVerdict(rootId, proposalId, sliceId, kind, reason, finalText)),
  setReviewBatch: async (rootId, path, cursor, batch) => {
    await unwrap(commands.setReviewBatch(rootId, path, cursor, batch));
  },
  commitDecisionBatch: (rootId, path, stamp) =>
    unwrap(commands.commitDecisionBatch(rootId, path, stamp)),
};

export interface TicketMailboxGateway {
  hostState(rootId: string): Promise<HostStateDto>;
  reviewState(rootId: string, path: string): Promise<ReviewStateDto_Serialize>;
  standings(rootId: string): Promise<MailboxStanding_Serialize[]>;
  setOrder(rootId: string, box: Box, entryIds: string[]): Promise<void>;
  setPinned(rootId: string, box: Box, entryId: string, pinned: boolean): Promise<void>;
  discard(rootId: string, box: Box, entryIds: string[]): Promise<void>;
  restore(rootId: string, entryId: string): Promise<boolean>;
  countermand(rootId: string, path: string, proposalIds: string[]): Promise<TextTransitionDto>;
  revertVerdicts(rootId: string, path: string, verdictIds: string[]): Promise<number>;
  recordVerdict(
    rootId: string,
    proposalId: string,
    sliceId: string,
    kind: string,
    reason: string | null,
    finalText: string | null,
  ): Promise<{ id: string }>;
  setReviewBatch(rootId: string, path: string, cursor: number, batch: string[]): Promise<void>;
  /** 裁决即落盘（D1），所以它要 stamp——`null` 表示不做 compare-and-swap。 */
  commitDecisionBatch(
    rootId: string,
    path: string,
    stamp: FileStamp_Serialize | null,
  ): Promise<unknown>;
}

export type MailboxRow = {
  readonly id: string;
  /** 一行读得完的称呼：提案的首句，或发送的要求。 */
  readonly title: string;
  /** 补充事实：来自哪份文档、几个 slice。 */
  readonly detail: string;
  /** 作者钉住的单：不参与后续排序，新单进来也压不下去。 */
  readonly pinned: boolean;
  /**
   * 已合并进正文、且尚未被逆向裁决冲销——只有这样的单能「撤回合并」。
   * 接受但仍在批次里（未合并）、已退回、已冲销的都是 false。判据是账本
   * 事实的投影；桥仍是最终权威，它拒了的措辞原样落在公告里。
   */
  readonly merged: boolean;
};

/** 一格的样子：缩略给侧栏，全量给管理页，`hidden` 是「还有 N 封」那个数。 */
export type MailboxGroup = {
  readonly peek: readonly MailboxRow[];
  readonly all: readonly MailboxRow[];
  readonly hidden: number;
};

export type MailboxView = {
  readonly draft: MailboxGroup;
  readonly unread: MailboxGroup;
  readonly done: MailboxGroup;
  /**
   * 弃置过的单：仍在库里、仍可取回，只是不占三格的视线。管理页的回收站读这里；
   * 没有它，「取回」这个动作没有一个能指出对象的列表。
   */
  readonly discarded: readonly MailboxRow[];
  readonly unreadCount: number;
};

export type Box = "draft" | "unread" | "done";

export const BOXES: readonly Box[] = ["draft", "unread", "done"];

/**
 * 侧栏一格显示几条。一个数、一处定义。
 *
 * 三格 × 5 行给侧栏一个上界，底部导航因此永远在屏内——实测未加上界时
 * 二十单就把整组全局导航挤出可视区（1440×900 下 scrollHeight 1320、
 * 底部导航 top 1081），两百单则是两百个 DOM 节点。
 */
export const MAILBOX_PEEK = 5;

const TITLE_CHARS = 18;

export class TicketMailbox extends Broadcast {
  #rootId: string | null = null;
  #path: string | null = null;
  #boxes: Record<Box, MailboxRow[]> = { draft: [], unread: [], done: [] };
  #discarded: MailboxRow[] = [];
  /** 每格里裁决 id 归属：done 行回溯时要交出哪些裁决。 */
  #verdictsOf = new Map<string, string[]>();
  /** 每个提案的合并事实：接受过、已冲销——「撤回合并」的资格判据。 */
  #merged = new Map<string, boolean>();
  /** 未判提案的原始行：饭盒要读原文与 slice。 */
  #unjudged: ProposalDto[] = [];
  /** 仍在批次里的裁决：只有它们可以回溯。 */
  #staged = new Set<string>();
  /**
   * 作者的安排，读自 Rust。位次缺席表示他没排过这一单——那一格的自然次序
   * 说了算，所以未排过的跟在排过的后面。
   */
  #standing = new Map<string, { rank: number | null; pinned: boolean; discarded: boolean }>();

  /**
   * `stampOf` 交出作者当前盖过的那一份磁盘状态。裁决即落盘（D1），而 stamp
   * 的唯一持有者是 DocumentSession——信箱自己存一份，两处就会各自过期。
   * 未接线时返回 null：不做 compare-and-swap，与接线前的行为一致。
   */
  constructor(
    private readonly gateway: TicketMailboxGateway,
    private readonly stampOf?: () => FileStamp_Serialize | null,
  ) {
    super();
  }

  /** 还没有一句裁决的提案：饭盒与印点读这里。 */
  get unjudgedProposals(): readonly ProposalDto[] {
    return this.#unjudged;
  }

  view(): MailboxView {
    return {
      draft: group(this.#boxes.draft),
      unread: group(this.#boxes.unread),
      done: group(this.#boxes.done),
      discarded: this.#discarded,
      unreadCount: this.#boxes.unread.length,
    };
  }

  /**
   * 重读世界。次序不因刷新而丢，也不因关窗而丢：安排读自 Rust。
   *
   * 弃置过的单在这一步就被滤掉——它们仍在库里、仍可取回，只是不再占着
   * 作者的视线。
   */
  async refresh(rootId: string, path: string): Promise<void> {
    this.#rootId = rootId;
    this.#path = path;
    const [host, review, standings] = await Promise.all([
      this.gateway.hostState(rootId),
      this.gateway.reviewState(rootId, path),
      this.gateway.standings(rootId),
    ]);
    this.#standing = new Map(
      standings.map((row) => [
        row.entryId,
        {
          rank: row.rank ?? null,
          pinned: row.pinned,
          discarded: row.discardedAt !== null,
        },
      ]),
    );

    const judged = new Set<string>();
    this.#verdictsOf = new Map();
    const accepted = new Set<string>();
    const countermanded = new Set<string>();
    for (const verdict of review.verdicts) {
      judged.add(verdict.proposalId);
      const list = this.#verdictsOf.get(verdict.proposalId) ?? [];
      this.#verdictsOf.set(verdict.proposalId, [...list, verdict.id]);
      if (verdict.kind === "accept" || verdict.kind === "accept-modified") {
        accepted.add(verdict.proposalId);
      }
      if (verdict.kind === "countermanded") countermanded.add(verdict.proposalId);
    }
    this.#staged = new Set(review.batch);
    // 合并过才有得冲：接受过、没有一裁决还停在批次里（未合并）、且尚未被
    // 逆向裁决冲销。桥按同一套事实再判一次，这里是让按钮先说人话的投影。
    this.#merged = new Map(
      [...accepted]
        .filter((id) => !countermanded.has(id))
        .map((id) => [
          id,
          !(this.#verdictsOf.get(id) ?? []).some((verdictId) => this.#staged.has(verdictId)),
        ]),
    );
    this.#unjudged = review.proposals.filter((proposal) => !judged.has(proposal.id));

    this.#boxes = {
      draft: host.tasks
        .filter((task) => task.progress === "draft")
        .map((task) => ({
          id: task.id,
          title: task.prompt,
          detail: task.document,
          pinned: this.#standing.get(task.id)?.pinned ?? false,
          merged: false,
        })),
      unread: review.proposals
        .filter((proposal) => !judged.has(proposal.id))
        .map((row) => this.#proposalRow(row)),
      done: review.proposals
        .filter((proposal) => judged.has(proposal.id))
        .map((row) => this.#proposalRow(row)),
    };
    // 弃置的单在归位之前收出来：回收站那份列表与三格用的是同一份投影，
    // 不是另一处拼出来的相似行。
    this.#discarded = BOXES.flatMap((box) =>
      this.#boxes[box].filter((row) => this.#standing.get(row.id)?.discarded ?? false),
    );
    for (const box of BOXES) {
      this.#boxes[box] = this.#arranged(this.#boxes[box]);
    }
    this.emit();
  }

  /**
   * 置顶或置底：只动一格之内的次序，并把整格的新次序写穿到 Rust。
   *
   * 整格一起写，而不是只写被动的那一行：位次是「在这一列里排第几」，
   * 逐行写会让两次调用交错成谁也没要过的次序。
   */
  async moveWithinBox(id: string, edge: "top" | "bottom"): Promise<void> {
    const box = this.#boxOf(id);
    if (box === null) return;
    const rows = this.#boxes[box];
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row === undefined) return;
    if (edge === "top") next.unshift(row);
    else next.push(row);

    // 「置顶」的意思是排在可排序的那些之前，不是排在钉住的单之前——
    // 钉住的单不参与排序，这正是 Pin 与置顶的分别。所以写下的位次只覆盖
    // 未钉住的行；把钉住的行一起编号，会让它此刻的显示位置变成它解 Pin
    // 之后的位次，作者从未这样要求过。
    const sortable = next.filter((entry) => !entry.pinned);
    for (const [rank, entry] of sortable.entries()) {
      const standing = this.#standing.get(entry.id);
      this.#standing.set(entry.id, {
        rank,
        pinned: false,
        discarded: standing?.discarded ?? false,
      });
    }
    // 本地这一步走与刷新同一条排序规则，否则屏幕上会出现一个下次刷新
    // 就消失的次序。
    this.#boxes = { ...this.#boxes, [box]: this.#arranged(next) };
    this.emit();
    await this.#persistOrder(box, sortable);
  }

  /**
   * Pin 或解 Pin。与置顶不是同一件事：置顶是一次排序，新单进来照样压得下去；
   * Pin 说的是这一单不参与后续排序。两个方向都写穿——钉住是作者的意图，
   * 取消也是。
   */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    const box = this.#boxOf(id);
    if (box === null || this.#rootId === null) return;
    await this.gateway.setPinned(this.#rootId, box, id, pinned);
    if (this.#path !== null) await this.refresh(this.#rootId, this.#path);
  }

  /**
   * 弃置若干单：作者放弃这批提案。
   *
   * **只做软删除**——提案行、账本、磁盘上的字节全都不动（INV-4：任何一层
   * 都没有永久删除）。它们从视线里退出，`restore` 把它们请回来。
   */
  async discard(ids: readonly string[]): Promise<void> {
    if (this.#rootId === null || ids.length === 0) return;
    const byBox = new Map<Box, string[]>();
    for (const id of ids) {
      const box = this.#boxOf(id);
      if (box === null) continue;
      byBox.set(box, [...(byBox.get(box) ?? []), id]);
    }
    for (const [box, entryIds] of byBox) {
      await this.gateway.discard(this.#rootId, box, entryIds);
    }
    if (this.#path !== null) await this.refresh(this.#rootId, this.#path);
  }

  /** 取回一单：弃置的回头路。返回 false 表示它本来就没被弃置。 */
  async restore(id: string): Promise<boolean> {
    if (this.#rootId === null) return false;
    const restored = await this.gateway.restore(this.#rootId, id);
    if (restored && this.#path !== null) await this.refresh(this.#rootId, this.#path);
    return restored;
  }

  /**
   * 撤回合并（逆向裁决）：对已合并的提案下冲销，文本回退到合并前，账本
   * append 冲销记录——不删旧记录。与历史面板的撤回是两回事：那是对编辑
   * 反悔，这是对判决反悔。
   *
   * 批量是一次 TextAction（一次撤销可还原整批），桥一次调用完成。未合并
   * 的单不进调用——假装它们也在其中，作者会以为退回了从未落进正文的字节。
   * 文本落地走与回档同一个接缝（调用方拿转移去喂编辑器），会话不认识
   * 编辑器。返回给作者读的一句话；null 表示静默完成。
   */
  async countermand(
    ids: readonly string[],
    apply: (transition: TextTransitionDto) => Promise<void>,
  ): Promise<string | null> {
    if (this.#rootId === null || this.#path === null) return null;
    const eligible = ids.filter((id) => this.#merged.get(id) === true);
    if (eligible.length === 0) {
      return "选中的单里没有已合并的提案——只有落进过正文的才能冲销合并。";
    }
    const rootId = this.#rootId;
    const path = this.#path;
    try {
      const transition = await this.gateway.countermand(rootId, path, eligible);
      await apply(transition);
    } catch (error) {
      return countermandRefusalText(error) ?? describe(error);
    }
    await this.refresh(rootId, path);
    const skipped = ids.length - eligible.length;
    return skipped > 0 ? `已冲销 ${eligible.length} 单的合并；${skipped} 单未曾合并不在内。` : null;
  }

  /** 批量取回：回收站多选之后的一次动作，世界只重读一遍。 */
  async restoreMany(ids: readonly string[]): Promise<void> {
    if (this.#rootId === null || ids.length === 0) return;
    for (const id of ids) {
      await this.gateway.restore(this.#rootId, id);
    }
    if (this.#path !== null) await this.refresh(this.#rootId, this.#path);
  }

  /** 批量置顶：多选之后的一次动作，整格只写一遍。 */
  async pinMany(ids: readonly string[], pinned: boolean): Promise<void> {
    if (this.#rootId === null) return;
    for (const id of ids) {
      const box = this.#boxOf(id);
      if (box === null) continue;
      await this.gateway.setPinned(this.#rootId, box, id, pinned);
    }
    if (this.#path !== null) await this.refresh(this.#rootId, this.#path);
  }

  #boxOf(id: string): Box | null {
    for (const box of BOXES) {
      if (this.#boxes[box].some((row) => row.id === id)) return box;
    }
    return null;
  }

  async #persistOrder(box: Box, rows: readonly MailboxRow[]): Promise<void> {
    if (this.#rootId === null) return;
    await this.gateway.setOrder(
      this.#rootId,
      box,
      rows.map((row) => row.id),
    );
  }

  /**
   * 判一单：它的每个 slice 落同一条裁决。判即写穿——与逐句裁决同一条
   * record_verdict 链，饭盒只是它的另一种呈现。
   */
  async judge(
    id: string,
    kind: "accept" | "accept-modified" | "reject",
    finalText: string | null,
  ): Promise<string | null> {
    if (this.#rootId === null || this.#path === null) return null;
    const proposal = this.#unjudged.find((candidate) => candidate.id === id);
    if (proposal === undefined) return "这单已经判过。";
    const rootId = this.#rootId;
    const path = this.#path;
    const writes = writesOf(
      {
        proposalId: proposal.id,
        proposalRun: proposal.run,
        before: proposal.before,
        after: proposal.after ?? "",
        kind: "replace",
        slices: proposal.slices,
        competing: false,
      },
      kind,
      finalText,
    );
    if (writes === null) {
      return "纯删除的提案不能改后接受——它没有可落文本的位置。";
    }
    const verdictIds: string[] = [];
    for (const write of writes) {
      const record = await this.gateway.recordVerdict(
        rootId,
        proposal.id,
        write.sliceId,
        write.kind,
        null,
        write.finalText,
      );
      verdictIds.push(record.id);
    }
    // 接受类裁决落成正文：单成一批，立即合并。退回只是记录，正文不动。
    if (kind !== "reject" && verdictIds.length > 0) {
      await this.gateway.setReviewBatch(rootId, path, 0, verdictIds);
      await this.gateway.commitDecisionBatch(rootId, path, this.stampOf?.() ?? null);
    }
    await this.refresh(rootId, path);
    return null;
  }

  /**
   * 回溯一单：它的全部裁决退回已回复。不在批次里的裁决不动——那可能已经是
   * 正文，而信箱不删历史。返回给作者读的一句话；null 表示静默完成。
   */
  async revert(id: string): Promise<string | null> {
    if (this.#rootId === null || this.#path === null) return null;
    const verdictIds = this.#verdictsOf.get(id) ?? [];
    const recallable = verdictIds.filter((verdictId) => this.#staged.has(verdictId));
    if (recallable.length === 0) {
      return "这单已经不能从这里撤回——它的裁决不在批次里，可能已落成正文。";
    }
    await this.gateway.revertVerdicts(this.#rootId, this.#path, recallable);
    await this.refresh(this.#rootId, this.#path);
    return null;
  }

  /**
   * 按作者的安排归位：弃置的移出视线，Pin 的在最前，其余按位次；
   * 没排过的跟在后面。
   *
   * 「没排过的跟在后面」不是排序细节：位次缺席与位次为 0 在数值上相邻，
   * 直接比较会把从未被碰过的单顶到作者亲手排在首位的单前面。
   */
  #arranged(rows: MailboxRow[]): MailboxRow[] {
    const visible = rows.filter((row) => !(this.#standing.get(row.id)?.discarded ?? false));
    const rankOf = (id: string): number => this.#standing.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
    return visible.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return rankOf(left.id) - rankOf(right.id);
    });
  }

  #proposalRow(proposal: { id: string; before: string; baseline: string }): MailboxRow {
    const firstLine = proposal.before.split("\n").find((line) => line.trim() !== "") ?? "";
    return {
      id: proposal.id,
      title: firstLine.slice(0, TITLE_CHARS) || "（空白段）",
      detail: proposal.baseline,
      pinned: this.#standing.get(proposal.id)?.pinned ?? false,
      merged: this.#merged.get(proposal.id) ?? false,
    };
  }
}

/**
 * 逆向裁决的三类具名拒绝，译成作者读得出的一句。
 *
 * 桥把拒绝写在 RefrainError 的 action 里（与 history-session 读 detail 同一个
 * precedent——桥上长出真正的错误码时，这个映射改读 code，措辞只有这里知道）。
 */
export function countermandRefusalText(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const action = (error as { action?: unknown }).action;
  if (typeof action !== "string") return null;
  if (action.includes("never merged")) {
    return "该提案未曾合并——没有落进过正文的字节可回退。";
  }
  if (action.includes("merged text has moved")) {
    return "原文已被后续编辑改动——当初合并进去的那段对不上了，回退整体拒绝。";
  }
  if (action.includes("deleted its scope")) {
    return "那次合并是整段删除，没有可锚定回退的字节。";
  }
  return null;
}

/** 一格的三种读法：侧栏读缩略，管理页读全量，格尾读被折起的条数。 */
function group(rows: readonly MailboxRow[]): MailboxGroup {
  return {
    peek: rows.slice(0, MAILBOX_PEEK),
    all: rows,
    hidden: Math.max(0, rows.length - MAILBOX_PEEK),
  };
}
