/**
 * 工单信箱（SPEC 9.6 的收件面）：三格状态机的唯一权威。
 *
 * - 待发送：起了草还没交出去的单（Task 停在 draft）。
 * - 未读：提案到了、还没有一句裁决的单。徽标计数就是它。
 * - 已处理：判过的单。还在批次里的可以回溯——退回未读，批次与账本同时放手。
 *
 * 数据来自 host_state（tasks）与 review_state（proposals/verdicts/batch），
 * 信箱只做投影与次序，不另存一份事实。置顶置底是作者的次序，信箱替他记住。
 */

import { unwrap } from "../bridge";
import type {
  HostStateDto,
  ProposalDto,
  ReviewStateDto_Serialize,
} from "../generated/bindings.gen";
import { commands } from "../generated/bindings.gen";
import { writesOf } from "./review-verdicts";
import { Broadcast } from "./session";

/** 生产 gateway：信箱的全部事实都过桥自 Rust。 */
export const browserMailboxGateway: TicketMailboxGateway = {
  hostState: (rootId) => unwrap(commands.hostState(rootId)),
  reviewState: (rootId, path) => unwrap(commands.reviewState(rootId, path)),
  revertVerdicts: (rootId, path, verdictIds) =>
    unwrap(commands.revertVerdicts(rootId, path, verdictIds)),
  recordVerdict: (rootId, proposalId, sliceId, kind, reason, finalText) =>
    unwrap(commands.recordVerdict(rootId, proposalId, sliceId, kind, reason, finalText)),
  setReviewBatch: async (rootId, path, cursor, batch) => {
    await unwrap(commands.setReviewBatch(rootId, path, cursor, batch));
  },
  commitDecisionBatch: (rootId, path) => unwrap(commands.commitDecisionBatch(rootId, path)),
};

export interface TicketMailboxGateway {
  hostState(rootId: string): Promise<HostStateDto>;
  reviewState(rootId: string, path: string): Promise<ReviewStateDto_Serialize>;
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
  commitDecisionBatch(rootId: string, path: string): Promise<unknown>;
}

export type MailboxRow = {
  readonly id: string;
  /** 一行读得完的称呼：提案的首句，或工单的要求。 */
  readonly title: string;
  /** 补充事实：来自哪份文档、几个 slice。 */
  readonly detail: string;
};

export type MailboxView = {
  readonly draft: readonly MailboxRow[];
  readonly unread: readonly MailboxRow[];
  readonly done: readonly MailboxRow[];
  readonly unreadCount: number;
};

type Box = "draft" | "unread" | "done";

const TITLE_CHARS = 18;

export class TicketMailbox extends Broadcast {
  #rootId: string | null = null;
  #path: string | null = null;
  #boxes: Record<Box, MailboxRow[]> = { draft: [], unread: [], done: [] };
  /** 每格里裁决 id 归属：done 行回溯时要交出哪些裁决。 */
  #verdictsOf = new Map<string, string[]>();
  /** 未判提案的原始行：饭盒要读原文与 slice。 */
  #unjudged: ProposalDto[] = [];
  /** 仍在批次里的裁决：只有它们可以回溯。 */
  #staged = new Set<string>();
  /** 作者的次序：每格一串 id，新到的排在末尾。 */
  #order: Record<Box, string[]> = { draft: [], unread: [], done: [] };

  constructor(private readonly gateway: TicketMailboxGateway) {
    super();
  }

  /** 还没有一句裁决的提案：饭盒与印点读这里。 */
  get unjudgedProposals(): readonly ProposalDto[] {
    return this.#unjudged;
  }

  view(): MailboxView {
    return {
      draft: this.#boxes.draft,
      unread: this.#boxes.unread,
      done: this.#boxes.done,
      unreadCount: this.#boxes.unread.length,
    };
  }

  /** 重读世界。次序不因刷新而丢：作者排过的单还在原来的位置。 */
  async refresh(rootId: string, path: string): Promise<void> {
    this.#rootId = rootId;
    this.#path = path;
    const [host, review] = await Promise.all([
      this.gateway.hostState(rootId),
      this.gateway.reviewState(rootId, path),
    ]);

    const judged = new Set<string>();
    this.#verdictsOf = new Map();
    for (const verdict of review.verdicts) {
      judged.add(verdict.proposalId);
      const list = this.#verdictsOf.get(verdict.proposalId) ?? [];
      this.#verdictsOf.set(verdict.proposalId, [...list, verdict.id]);
    }
    this.#staged = new Set(review.batch);
    this.#unjudged = review.proposals.filter((proposal) => !judged.has(proposal.id));

    this.#boxes = {
      draft: host.tasks
        .filter((task) => task.progress === "draft")
        .map((task) => ({ id: task.id, title: task.prompt, detail: task.document })),
      unread: review.proposals
        .filter((proposal) => !judged.has(proposal.id))
        .map((row) => proposalRow(row)),
      done: review.proposals
        .filter((proposal) => judged.has(proposal.id))
        .map((row) => proposalRow(row)),
    };
    for (const box of ["draft", "unread", "done"] as const) {
      this.#boxes[box] = this.#ordered(box, this.#boxes[box]);
    }
    this.emit();
  }

  /** 置顶或置底：只动一格之内的次序。 */
  moveWithinBox(id: string, edge: "top" | "bottom"): void {
    for (const box of ["draft", "unread", "done"] as const) {
      const rows = this.#boxes[box];
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) continue;
      const next = [...rows];
      const [row] = next.splice(index, 1);
      if (row === undefined) return;
      if (edge === "top") next.unshift(row);
      else next.push(row);
      this.#boxes = { ...this.#boxes, [box]: next };
      this.#order[box] = next.map((entry) => entry.id);
      this.emit();
      return;
    }
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
      await this.gateway.commitDecisionBatch(rootId, path);
    }
    await this.refresh(rootId, path);
    return null;
  }

  /**
   * 回溯一单：它的全部裁决退回未读。不在批次里的裁决不动——那可能已经是
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

  /** 按作者排过的次序归位；没排过的跟在后面。 */
  #ordered(box: Box, rows: MailboxRow[]): MailboxRow[] {
    const rank = new Map(this.#order[box].map((id, index) => [id, index]));
    return [...rows].sort((left, right) => {
      const a = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const b = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return a - b;
    });
  }
}

function proposalRow(proposal: { id: string; before: string; baseline: string }): MailboxRow {
  const firstLine = proposal.before.split("\n").find((line) => line.trim() !== "") ?? "";
  return {
    id: proposal.id,
    title: firstLine.slice(0, TITLE_CHARS) || "（空白段）",
    detail: proposal.baseline,
  };
}
