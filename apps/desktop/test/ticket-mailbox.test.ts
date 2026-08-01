/**
 * 发送信箱：三格状态机是应用里「下一步做什么」的唯一权威。
 *
 * 待发送——起了草还没交出去的单（Task 停在 draft）。
 * 未读——提案到了、还没有一句裁决的单（徽标计数就是它）。
 * 已裁决——判过的单。还在批次里的可以回溯：退回已回复，批次与账本同时放手。
 */

import { describe, expect, test } from "bun:test";

import type {
  HostStateDto,
  ProposalDto,
  ReviewStateDto_Serialize,
  VerdictRecord_Serialize,
} from "../src/generated/bindings.gen";
import {
  MAILBOX_PEEK,
  TicketMailbox,
  type TicketMailboxGateway,
} from "../src/shell/ticket-mailbox";

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

type Standing = {
  entryId: string;
  boxName: "draft" | "unread" | "done";
  rank: number | null;
  pinned: boolean;
  discardedAt: string | null;
};

type World = {
  tasks: HostStateDto["tasks"];
  proposals: ProposalDto[];
  verdicts: VerdictRecord_Serialize[];
  batch: string[];
  /** Rust 侧 `mailbox_standing` 的替身：次序、Pin、弃置都持久在这里。 */
  standings: Standing[];
};

/** 一座可以改写的小世界：gateway 每次都读它此刻的样子。 */
function fixture(world: Partial<World>) {
  const state: World = {
    tasks: [],
    proposals: [],
    verdicts: [],
    batch: [],
    standings: [],
    ...world,
  };

  /** 像真表一样按 entry_id upsert：两次写同一单不该变成两行。 */
  const upsert = (entryId: string, patchRow: Partial<Standing>, boxName: Standing["boxName"]) => {
    const existing = state.standings.find((row) => row.entryId === entryId);
    if (existing === undefined) {
      state.standings = [
        ...state.standings,
        { entryId, boxName, rank: null, pinned: false, discardedAt: null, ...patchRow },
      ];
      return;
    }
    state.standings = state.standings.map((row) =>
      row.entryId === entryId ? { ...row, boxName, ...patchRow } : row,
    );
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
    async standings() {
      return state.standings;
    },
    async setOrder(_rootId, box, entryIds) {
      calls.push(`order:${box}:${entryIds.join("+")}`);
      entryIds.forEach((entryId, index) => {
        upsert(entryId, { rank: index }, box);
      });
    },
    async setPinned(_rootId, box, entryId, pinned) {
      calls.push(`pin:${entryId}:${pinned}`);
      upsert(entryId, { pinned }, box);
    },
    async discard(_rootId, box, entryIds) {
      calls.push(`discard:${entryIds.join("+")}`);
      for (const entryId of entryIds) upsert(entryId, { discardedAt: "1" }, box);
    },
    async restore(_rootId, entryId) {
      const row = state.standings.find((entry) => entry.entryId === entryId);
      if (row === undefined || row.discardedAt === null) return false;
      state.standings = state.standings.map((entry) =>
        entry.entryId === entryId ? { ...entry, discardedAt: null } : entry,
      );
      return true;
    },
  };
  return { gateway, calls, state };
}

describe("发送信箱", () => {
  test("三格各归各：草稿进待发送，未判进已回复，判过进已裁决", async () => {
    const { gateway } = fixture({
      tasks: [task("t1", "draft"), task("t2", "open")],
      proposals: [proposal("p1", "第一句"), proposal("p2", "第二句")],
      verdicts: [verdict("v1", "p2")],
      batch: ["v1"],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    const view = mailbox.view();
    expect(view.draft.all.map((row) => row.id)).toEqual(["t1"]);
    expect(view.unread.all.map((row) => row.id)).toEqual(["p1"]);
    expect(view.done.all.map((row) => row.id)).toEqual(["p2"]);
    expect(view.unreadCount).toBe(1);
  });

  test("置顶着底只动一格之内的次序", async () => {
    const { gateway } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二"), proposal("p3", "三")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    await mailbox.moveWithinBox("p2", "top");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p2", "p1", "p3"]);

    await mailbox.moveWithinBox("p2", "bottom");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p1", "p3", "p2"]);
  });

  test("回溯把判过的单退回已回复", async () => {
    const { gateway, calls, state } = fixture({
      proposals: [proposal("p1", "第一句")],
      verdicts: [verdict("v1", "p1")],
      batch: ["v1"],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().done.all).toHaveLength(1);

    await mailbox.revert("p1");
    expect(calls).toContain("revert:v1");

    // 后端放手之后，信箱重读到的世界里它已经回到已回复。
    state.verdicts = [];
    state.batch = [];
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p1"]);
    expect(mailbox.view().done.all).toHaveLength(0);
  });

  test("已裁决但不在批次里的单不回溯——它可能已经落成正文", async () => {
    const { gateway, calls } = fixture({
      proposals: [proposal("p1", "第一句")],
      verdicts: [verdict("v1", "p1")],
      batch: [],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    const notice = await mailbox.revert("p1");
    expect(calls.filter((entry) => entry.startsWith("revert:"))).toEqual([]);
    expect(notice).toContain("不能");
  });

  test("判一单：每个 slice 落同一条裁决，判完离开已回复", async () => {
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
    await mailbox.moveWithinBox("p3", "top");

    // 新提案到达不该冲掉作者排好的次序。
    state.proposals = [...state.proposals, proposal("p4", "四")];
    await mailbox.refresh("root", "章一.md");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p3", "p1", "p2", "p4"]);
  });

  test("侧栏只挂缩略：一格超过上界就折起来，剩下的进管理页", async () => {
    const many = Array.from({ length: 23 }, (_, index) => proposal(`p${index}`, `第${index}句`));
    const { gateway } = fixture({ proposals: many });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    const unread = mailbox.view().unread;
    // 上界是缩略这件事的全部意义：没有它，二十几单就把底部导航挤出可视区。
    expect(unread.peek).toHaveLength(MAILBOX_PEEK);
    expect(unread.all).toHaveLength(23);
    expect(unread.hidden).toBe(23 - MAILBOX_PEEK);
    // 缩略取的是这一格的前几条，不是随便几条。
    expect(unread.peek.map((row) => row.id)).toEqual(
      unread.all.slice(0, MAILBOX_PEEK).map((row) => row.id),
    );
  });

  test("不足上界时一条也不折，「还有 N 封」不该凭空出现", async () => {
    const { gateway } = fixture({ proposals: [proposal("p1", "一"), proposal("p2", "二")] });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    expect(mailbox.view().unread.peek).toHaveLength(2);
    expect(mailbox.view().unread.hidden).toBe(0);
  });

  test("Pin 与置顶不同：钉住的单压不下去，取消之后才回到位次里", async () => {
    const { gateway } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二"), proposal("p3", "三")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    await mailbox.setPinned("p3", true);
    // 把别的单排到最前面的位次上——若 Pin 只是一次排序，它就该赢。
    await mailbox.moveWithinBox("p1", "top");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p3", "p1", "p2"]);
    expect(mailbox.view().unread.all[0]?.pinned).toBe(true);

    // 钉住期间的置顶只在可排序的那些里生效，没有顺手给 p3 编上位次——
    // 否则解 Pin 会把它此刻的显示位置变成它的位次，作者没这样要求过。
    // 两个方向都要能走：钉住是意图，取消也是。
    await mailbox.setPinned("p3", false);
    const after = mailbox.view().unread.all;
    expect(after[0]?.pinned).toBe(false);
    expect(after.map((row) => row.id)).toEqual(["p1", "p2", "p3"]);

    // 解 Pin 之后它才重新参与排序：这一步把它提上去，钉住时反而做不到。
    await mailbox.moveWithinBox("p3", "top");
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p3", "p1", "p2"]);
  });

  test("弃置只是软删除：单退出视线，账本与提案一行不动，取回把它请回来", async () => {
    const { gateway, calls, state } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    await mailbox.discard(["p1"]);
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p2"]);
    // 提案本身没有被删——弃置动的是作者的安排，不是事实（INV-4）。
    expect(state.proposals.map((row) => row.id)).toEqual(["p1", "p2"]);
    expect(calls).not.toContain("revert:p1");

    expect(await mailbox.restore("p1")).toBe(true);
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p1", "p2"]);
  });

  test("多选批量弃置：一次动作处理整批", async () => {
    const { gateway, state } = fixture({
      proposals: [proposal("p1", "一"), proposal("p2", "二"), proposal("p3", "三")],
    });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    await mailbox.discard(["p1", "p3"]);
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p2"]);
    expect(state.proposals).toHaveLength(3);
  });

  test("取回一单从未弃置过的单，什么也不改", async () => {
    const { gateway } = fixture({ proposals: [proposal("p1", "一")] });
    const mailbox = new TicketMailbox(gateway);
    await mailbox.refresh("root", "章一.md");

    expect(await mailbox.restore("p1")).toBe(false);
    expect(mailbox.view().unread.all.map((row) => row.id)).toEqual(["p1"]);
  });
});
