import { describe, expect, test } from "bun:test";
import type { RevertOutcomeDto, TextActionSummaryDto } from "../src/generated/bindings.gen";
import {
  actionTimeText,
  causeText,
  type HistoryGateway,
  HistorySession,
  revertRefusalText,
} from "../src/shell/history-session";

const NOW = new Date(2026, 7, 2, 15, 30);

/** 一天中的固定时刻，与 NOW 同日或不同日。 */
const at = (hour: number, minute: number, day = 2): string =>
  String(new Date(2026, 7, day, hour, minute).getTime());

const row = (
  id: string,
  ordinal: number,
  cause: string,
  undone = false,
  createdAt = at(10, 0),
): TextActionSummaryDto => ({ id, ordinal, cause, createdAt, undone });

/** 新在前的五步历史：a3 已撤回。 */
const FIVE: TextActionSummaryDto[] = [
  row("a5", 5, "author edit", false, at(14, 5)),
  row("a4", 4, "undo: author edit", false, at(13, 40)),
  row("a3", 3, "author edit", true, at(12, 1)),
  row("a2", 2, "decision-batch", false, at(11, 20)),
  row("a1", 1, "open", false, at(9, 30, 1)),
];

interface Harness {
  session: HistorySession;
  notices: string[];
  failures: string[];
  listCalls: string[];
  revertCalls: string[];
  setRows(rows: TextActionSummaryDto[]): void;
  failList(error: unknown): void;
  failRevert(error: unknown): void;
  holdNextList(): void;
  releaseHeld(rows: TextActionSummaryDto[]): void;
  settle(): Promise<void>;
}

function harness(): Harness {
  const notices: string[] = [];
  const failures: string[] = [];
  const listCalls: string[] = [];
  const revertCalls: string[] = [];
  let rows: TextActionSummaryDto[] = [];
  let listFailure: unknown = null;
  let revertFailure: unknown = null;
  let holdNext = false;
  let heldResolve: ((rows: TextActionSummaryDto[]) => void) | null = null;

  const gateway: HistoryGateway = {
    listTextActions(rootId, path) {
      listCalls.push(`${rootId}:${path}`);
      if (holdNext) {
        holdNext = false;
        return new Promise((resolve) => {
          heldResolve = resolve;
        });
      }
      const failure = listFailure;
      listFailure = null;
      return failure !== null ? Promise.reject(failure) : Promise.resolve([...rows]);
    },
    revertToAction(_rootId, _path, actionId) {
      revertCalls.push(actionId);
      if (revertFailure !== null) {
        const failure = revertFailure;
        revertFailure = null;
        return Promise.reject(failure);
      }
      const outcome: RevertOutcomeDto = {
        revision: "r-after",
        transitions: [
          { revision: "r-mid", actionId: "a5", touchedBlocks: ["b9"] },
          { revision: "r-after", actionId: "a4", touchedBlocks: ["b3"] },
        ],
        undone: ["a5", "a4"],
      };
      return Promise.resolve(outcome);
    },
  };

  const session = new HistorySession(
    gateway,
    {
      notice: (text) => {
        if (text !== null) notices.push(text);
      },
      failed: (reason) => failures.push(reason),
    },
    (error) => String(error),
    () => NOW,
  );

  return {
    session,
    notices,
    failures,
    listCalls,
    revertCalls,
    setRows: (next) => {
      rows = next;
    },
    failList: (error) => {
      listFailure = error;
    },
    failRevert: (error) => {
      revertFailure = error;
    },
    holdNextList: () => {
      holdNext = true;
    },
    releaseHeld: (next) => {
      const resolve = heldResolve;
      heldResolve = null;
      resolve?.(next);
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const target = { rootId: "root", path: "章.md" };

describe("causeText：领域措辞到面板措辞", () => {
  test("四种已知原因各有说法，未知的原样示出", () => {
    expect(causeText("open")).toBe("打开文档");
    expect(causeText("author edit")).toBe("编辑");
    expect(causeText("decision-batch")).toBe("裁决合并");
    expect(causeText("undo: author edit")).toBe("撤销：编辑");
    expect(causeText("kara rewrite")).toBe("kara rewrite");
  });
});

describe("actionTimeText：同日给时分，更早补日期", () => {
  test("同日只给时分", () => {
    expect(actionTimeText(at(14, 5), NOW)).toBe("14:05");
    expect(actionTimeText(at(9, 3), NOW)).toBe("09:03");
  });
  test("更早的补上日期", () => {
    expect(actionTimeText(at(9, 30, 1), NOW)).toBe("8月1日 09:30");
  });
});

describe("revertRefusalText：两类拒绝是公告措辞", () => {
  const refusal = (detail: string) => ({ code: "io", detail });
  test("目标已不在历史", () => {
    expect(
      revertRefusalText(
        refusal("Text Action abc is not in the undo history: unknown or already undone"),
      ),
    ).toBe("那一步已不在可撤销的历史里——可能已被撤销，或太早了。");
  });
  test("上方有带着裁决的一步", () => {
    expect(
      revertRefusalText(
        refusal("Text Action abc is not invertible: its verdicts are already ledger facts"),
      ),
    ).toBe("那一步之后有改动带着裁决记录，不能越过它回档。");
  });
  test("其他错误不冒领", () => {
    expect(revertRefusalText(refusal("disk gone"))).toBeNull();
    expect(revertRefusalText(new Error("x"))).toBeNull();
    expect(revertRefusalText("x")).toBeNull();
  });
});

describe("HistorySession：列表与刷新", () => {
  test("没有文档时是 absent，不发出列表请求", async () => {
    const h = harness();
    h.session.sync(null, false, true);
    await h.settle();
    expect(h.session.view().rows.kind).toBe("absent");
    expect(h.listCalls).toEqual([]);
  });

  test("同步一个文档后列出它的历史：措辞、时刻、已撤回、步数", async () => {
    const h = harness();
    h.setRows(FIVE);
    h.session.sync(target, false, true);
    await h.settle();
    const view = h.session.view();
    expect(h.listCalls).toEqual(["root:章.md"]);
    if (view.rows.kind !== "ready") throw new Error("rows not ready");
    expect(view.rows.rows.map((r) => [r.id, r.cause, r.undone, r.steps])).toEqual([
      ["a5", "编辑", false, 0],
      ["a4", "撤销：编辑", false, 1],
      ["a3", "编辑", true, 2],
      ["a2", "裁决合并", false, 2],
      ["a1", "打开文档", false, 3],
    ]);
    // 已撤回的 a3 不计入「之后再撤几步」：回档走不到已撤回的行。
    expect(view.rows.rows[0]?.time).toBe("14:05");
    expect(view.rows.rows[4]?.time).toBe("8月1日 09:30");
  });

  test("同一文档再同步是重列（行动执行、保存落盘都走这条路）", async () => {
    const h = harness();
    h.setRows(FIVE);
    h.session.sync(target, false, true);
    await h.settle();
    h.setRows([row("a6", 6, "author edit"), ...FIVE]);
    h.session.sync(target, true, true);
    await h.settle();
    expect(h.listCalls).toHaveLength(2);
    const view = h.session.view();
    if (view.rows.kind !== "ready") throw new Error("rows not ready");
    expect(view.rows.rows[0]?.id).toBe("a6");
    expect(view.dirty).toBe(true);
  });

  test("面板关着：击键同步不发一次桥往返，开面板那一下补全量", async () => {
    const h = harness();
    h.setRows(FIVE);
    // 关着：同步多少次都不该有请求。
    h.session.sync(target, false, false);
    h.session.sync(target, true, false);
    h.session.sync(target, true, false);
    await h.settle();
    expect(h.listCalls).toEqual([]);
    // 打开的那一下补一次全量——关窗期间错过的都从这里追平。
    h.session.sync(target, true, true);
    await h.settle();
    expect(h.listCalls).toEqual(["root:章.md"]);
  });

  test("换文档重置：确认收回，按新文档重列", async () => {
    const h = harness();
    h.setRows(FIVE);
    h.session.sync(target, false, true);
    await h.settle();
    h.session.askRevert("a2");
    expect(h.session.view().confirming?.actionId).toBe("a2");
    h.session.sync({ rootId: "root", path: "二章.md" }, false, true);
    await h.settle();
    expect(h.session.view().confirming).toBeNull();
    expect(h.listCalls.at(-1)).toBe("root:二章.md");
  });

  test("慢响应落到已换人的文档上时丢弃", async () => {
    const h = harness();
    h.holdNextList();
    h.session.sync(target, false, true);
    h.setRows(FIVE);
    h.session.sync({ rootId: "root", path: "二章.md" }, false, true);
    await h.settle();
    const view = h.session.view();
    if (view.rows.kind !== "ready") throw new Error("rows not ready");
    expect(view.rows.rows.map((r) => r.id)).toEqual(FIVE.map((r) => r.id));
    // 第一次（被扣住的）响应带着另一份列表后到，也不许覆盖现在的文档。
    h.releaseHeld([row("ghost", 1, "open")]);
    await h.settle();
    const after = h.session.view();
    if (after.rows.kind !== "ready") throw new Error("rows not ready");
    expect(after.rows.rows.map((r) => r.id)).toEqual(FIVE.map((r) => r.id));
    expect(h.listCalls).toEqual(["root:章.md", "root:二章.md"]);
  });

  test("列表读不出来：留着上一份列表，失败走公告", async () => {
    const h = harness();
    h.setRows(FIVE);
    h.session.sync(target, false, true);
    await h.settle();
    h.failList(new Error("db locked"));
    h.session.sync(target, false, true);
    await h.settle();
    expect(h.failures.at(-1)).toContain("db locked");
    const view = h.session.view();
    if (view.rows.kind !== "ready") throw new Error("rows lost after a failed refresh");
    expect(view.rows.rows).toHaveLength(5);
  });
});

describe("HistorySession：两步回档", () => {
  const opened = async (h: Harness): Promise<void> => {
    h.setRows(FIVE);
    h.session.sync(target, false, true);
    await h.settle();
  };

  test("第一下立确认：带着将撤回的步数；再点同一行是收回", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    expect(h.session.view().confirming).toEqual({
      actionId: "a2",
      cause: "裁决合并",
      steps: 2,
    });
    h.session.askRevert("a2");
    expect(h.session.view().confirming).toBeNull();
  });

  test("已撤回的行、当前位置、未知行都不立确认", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a3");
    h.session.askRevert("a5");
    h.session.askRevert("nope");
    expect(h.session.view().confirming).toBeNull();
  });

  test("没有先立确认，确认是空操作", async () => {
    const h = harness();
    await opened(h);
    await h.session.confirmRevert(async () => undefined);
    expect(h.revertCalls).toEqual([]);
  });

  test("第二下真的回档：桥收到目标，落点拿到转移，被撤的行先 locally 标出", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    const applied: string[] = [];
    await h.session.confirmRevert(async (transition) => {
      applied.push(transition.revision);
      // 落点是最后一棒的真实转移：触块交给宿主恢复光标，不再伪造空数组。
      expect(transition.touchedBlocks).toEqual(["b3"]);
      expect(transition.actionId).toBe("a4");
    });
    expect(h.revertCalls).toEqual(["a2"]);
    expect(applied).toEqual(["r-after"]);
    expect(h.session.view().confirming).toBeNull();
    // 落盘前磁盘上的 undone 还没翻，视图先如实标出刚撤回的两步。
    const view = h.session.view();
    if (view.rows.kind !== "ready") throw new Error("rows not ready");
    expect(view.rows.rows.find((r) => r.id === "a5")?.undone).toBe(true);
    expect(view.rows.rows.find((r) => r.id === "a4")?.undone).toBe(true);
    expect(view.rows.rows.find((r) => r.id === "a2")?.undone).toBe(false);
  });

  test("保存落盘（dirty → clean）后本地补标退场，磁盘事实接管", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    await h.session.confirmRevert(async () => undefined);
    // 保存把 a4/a5 的 undone 翻成真，本地补标清掉后视图必须不变。
    h.setRows(FIVE.map((r) => (r.id === "a4" || r.id === "a5" ? { ...r, undone: true } : r)));
    h.session.sync(target, true, true);
    await h.settle();
    h.session.sync(target, false, true);
    await h.settle();
    const view = h.session.view();
    if (view.rows.kind !== "ready") throw new Error("rows not ready");
    expect(view.rows.rows.find((r) => r.id === "a5")?.undone).toBe(true);
  });

  test("回档进行中第二次确认被吞掉", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    const first = h.session.confirmRevert(async () => undefined);
    h.session.askRevert("a1");
    await h.session.confirmRevert(async () => undefined);
    await first;
    expect(h.revertCalls).toEqual(["a2"]);
  });

  test("目标已不在历史：公告，不落文本，不走失败", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    h.failRevert({
      code: "io",
      detail: "Text Action a2 is not in the undo history: unknown or already undone",
    });
    let applied = false;
    await h.session.confirmRevert(async () => {
      applied = true;
    });
    expect(applied).toBe(false);
    expect(h.notices.at(-1)).toBe("那一步已不在可撤销的历史里——可能已被撤销，或太早了。");
    expect(h.failures).toEqual([]);
  });

  test("上方有带着裁决的一步：公告措辞说清为什么", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    h.failRevert({
      code: "io",
      detail: "Text Action a4 is not invertible: its verdicts are already ledger facts",
    });
    await h.session.confirmRevert(async () => undefined);
    expect(h.notices.at(-1)).toBe("那一步之后有改动带着裁决记录，不能越过它回档。");
    expect(h.failures).toEqual([]);
  });

  test("意料之外的错误走失败通道", async () => {
    const h = harness();
    await opened(h);
    h.session.askRevert("a2");
    h.failRevert(new Error("disk gone"));
    await h.session.confirmRevert(async () => undefined);
    expect(h.failures.at(-1)).toContain("disk gone");
  });
});
