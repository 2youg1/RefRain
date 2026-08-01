/**
 * 工单信箱：三格状态机是应用里「下一步做什么」的唯一权威。
 *
 * 待发送——起了草还没交出去的单（Task 停在 draft）。
 * 未读——提案到了、还没有一句裁决的单（徽标计数就是它）。
 * 已处理——判过的单。还在批次里的可以回溯：退回未读，批次与账本同时放手。
 */

import { describe, expect, test } from "bun:test";

import type {
  HostStateDto,
  ProposalDto,
  ReviewStateDto_Serialize,
  VerdictRecord_Serialize,
} from "../src/generated/bindings.gen";
import { TicketMailbox, type TicketMailboxGateway } from "../src/shell/ticket-mailbox";

const task = (id: string, progress: string): HostStateDto["tasks"][number] => ({
  id,
  baseline: "b",
  document: "章一.md",
  prompt: "改克制些",
  progress,
});

const proposal = (id: string, before: string): ProposalDto => ({
  id,
  run: "r1",
  baseline: "b",
  before,
  after: `${before}（改）`,
  changeClass: "edit",
  slices: [],
});

const verdict = (id: string, proposalId: string): VerdictRecord_Serialize => ({
  id,
  proposalId,
  sliceId: "ch01:b1",
  kind: "accept",
  finalText: null,
  reason: null,
  decidedAt: "1",
  legacyBaseline: null,
});

type World = {
  tasks: HostStateDto["tasks"];
  proposals: ProposalDto[];
  verdicts: VerdictRecord_Serialize[];
  batch: string[];
};

/** 一座可以改写的小世界：gateway 每次都读它此刻的样子。 */
function fixture(world: Partial<World>) {
  const state: World = {
    tasks: [],
    proposals: [],
    verdicts: [],
    batch: [],
    ...world,
  };
  const calls: string[] = [];
  const gateway: TicketMailboxGateway = {
    async hostState() {
      return { tasks: state.tasks, runs: [], recoveryRequired: [], awaitingLaunch: [] };
    },
    async reviewState() {
      return {
        proposals: state.proposals,
        verdicts: state.verdicts,
        cursor: 0,
        batch: state.batch,
      } as ReviewStateDto_Serialize;
    },
    async revertVerdicts(_rootId, _path, ids) {
      calls.push(`revert:${ids.join("+")}`);
      return ids.length;
    },
    async recordVerdict(_rootId, proposalId, sliceId, kind, _reason, _finalText) {
      calls.push(`judge:${proposalId}:${sliceId}:${kind}`);
      state.verdicts = [...state.verdicts, verdict(`v-${sliceId}`, proposalId)];
      return { id: `v-${sliceId}` };
    },
    async setReviewBatch(_rootId, _path, _cursor, batch) {
      calls.push(`stage:${batch.join("+")}`);
      state.batch = batch;
    },
    async commitDecisionBatch() {
      calls.push("commit");
      state.batch = [];
    },
  };
  return { gateway, calls, state };
}

describe("工单信箱", () => {
  test("三格各归各：草稿进待发送，未判进未读，判过进已处理", async () => {
    const { gateway } = fixture({
      tasks: [task("t1", "draft"), task("t2", "open")],
      proposals: [proposal("p1", "第一句"), proposal("p2", "第二句")],
      verdicts: [verdict("v1", "p2")],
      batch: ["v1"],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    const view = mailbox.view();
    expect(view.draft.map((row) => row.id)).toEqual(["t1"]);
    expect(view.unread.map((row) => row.id)).toEqual(["p1"]);
    expect(view.done.map((row) => row.id)).toEqual(["p2"]);
    expect(view.unreadCount).toBe(1);
  });

  test("置顶着底只动一格之内的次序", async () => {
    const { gateway } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二"), proposal("p3", "三")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    mailbox.moveWithinBox("p2", "top");
    expect(mailbox.view().unread.map((row) => row.id)).toEqual(["p2", "p1", "p3"]);

    mailbox.moveWithinBox("p2", "bottom");
    expect(mailbox.view().unread.map((row) => row.id)).toEqual(["p1", "p3", "p2"]);
  });

  test("回溯把判过的单退回未读", async () => {
    const { gateway, calls, state } = fixture({
      proposals: [proposal("p1", "第一句")],
      verdicts: [verdict("v1", "p1")],
      batch: ["v1"],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().done).toHaveLength(1);

    await mailbox.revert("p1");
    expect(calls).toEqual(["revert:v1"]);

    // 后端放手之后，信箱重读到的世界里它已经回到未读。
    state.verdicts = [];
    state.batch = [];
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().unread.map((row) => row.id)).toEqual(["p1"]);
    expect(mailbox.view().done).toHaveLength(0);
  });

  test("已处理但不在批次里的单不回溯——它可能已经落成正文", async () => {
    const { gateway, calls } = fixture({
      proposals: [proposal("p1", "第一句")],
      verdicts: [verdict("v1", "p1")],
      batch: [],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    const notice = await mailbox.revert("p1");
    expect(calls).toEqual([]);
    expect(notice).toContain("不能");
  });

  test("判一单：每个 slice 落同一条裁决，判完离开未读", async () => {
    const { gateway, calls, state } = fixture({
      proposals: [
        {
          ...proposal("p1", "第一句。"),
          slices: [
            { id: "p1:0", kind: "replace", text: "第一句。", lead: "", trail: "" },
            { id: "p1:1", kind: "replace", text: "第二句。", lead: "", trail: "" },
          ],
        },
      ],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().unreadCount).toBe(1);

    await mailbox.judge("p1", "accept", null);
    // 接受类裁决落成正文：记录 → 入批 → 合并，一条不缺。
    expect(calls).toEqual([
      "judge:p1:p1:0:accept",
      "judge:p1:p1:1:accept",
      "stage:v-p1:0+v-p1:1",
      "commit",
    ]);
    expect(mailbox.view().unreadCount).toBe(0);
    expect(state.verdicts).toHaveLength(2);
  });

  test("退回只记录，正文不动（没有入批与合并）", async () => {
    const { gateway, calls } = fixture({
      proposals: [
        {
          ...proposal("p1", "第一句。"),
          slices: [{ id: "p1:0", kind: "replace", text: "第一句。", lead: "", trail: "" }],
        },
      ],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    await mailbox.judge("p1", "reject", null);
    expect(calls).toEqual(["judge:p1:p1:0:reject"]);
    expect(calls).not.toContain("commit");
  });

  test("刷新之间记住作者排过的次序", async () => {
    const { gateway, state } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二"), proposal("p3", "三")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");
    mailbox.moveWithinBox("p3", "top");

    // 新提案到达不该冲掉作者排好的次序。
    state.proposals = [...state.proposals, proposal("p4", "四")];
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().unread.map((row) => row.id)).toEqual(["p3", "p1", "p2", "p4"]);
  });
});
