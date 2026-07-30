/**
 * 派发票据的行为，不开浏览器就能问。
 *
 * 这些逻辑此前住在一个 995 行的组件里，二十五处 setModel 散在事件回调之间，
 * 于是「发出之后是什么状态」这个问题只能靠人点一遍来回答。下面每一条都是作者
 * 会察觉的事实。
 */

import { describe, expect, test } from "bun:test";

import type {
  AgentReadingDto,
  AuthorizeDispatchRequest,
  BlockDto,
  CollectOutcomeDto,
  DispatchPreviewDto,
  DocumentRow,
  HostStateDto,
  MaterialDraftRow_Serialize,
  RunDto,
  TaskDto,
} from "../src/generated/bindings.gen";
import {
  type DispatchContext,
  type DispatchGateway,
  DispatchSession,
} from "../src/shell/dispatch-session";

const block = (id: string): BlockDto => ({ id }) as unknown as BlockDto;

const run = (id: string, progress: string, taskId = "task-1"): RunDto =>
  ({ id, progress, taskId, workspace: `runs/${id}` }) as unknown as RunDto;

const preview = (digest: string): DispatchPreviewDto =>
  ({ digest, manifest: [], requestMd: "# 请求" }) as unknown as DispatchPreviewDto;

const host = (runs: RunDto[], tasks: { id: string; document: string }[]): HostStateDto =>
  ({ runs, tasks }) as unknown as HostStateDto;

interface Recorder {
  readonly calls: string[];
  readonly authorized: AuthorizeDispatchRequest[];
  collected: number[];
  saved: DocumentRow[];
  hostState: HostStateDto;
  drafts: MaterialDraftRow_Serialize[];
  ledger: AgentReadingDto[];
  outcome: CollectOutcomeDto;
  fail: string | null;
}

const context: DispatchContext = {
  rootId: "root-1",
  path: "ch01.md",
  blocks: [block("b1"), block("b2"), block("b3"), block("b4")],
  materials: [{ path: "m1.md", label: "笔记" }],
};

const rig = (
  overrides: Partial<Recorder> = {},
): { session: DispatchSession; recorder: Recorder } => {
  const recorder: Recorder = {
    calls: [],
    authorized: [],
    collected: [],
    saved: [],
    hostState: host([], []),
    drafts: [],
    ledger: [],
    outcome: { kind: "waiting" } as unknown as CollectOutcomeDto,
    fail: null,
    ...overrides,
  };
  const guardFail = (name: string): void => {
    recorder.calls.push(name);
    if (recorder.fail === name) throw new Error(`${name} 拒绝`);
  };
  const gateway: DispatchGateway = {
    hostState: async () => {
      guardFail("hostState");
      return recorder.hostState;
    },
    listMaterialDrafts: async () => {
      guardFail("listMaterialDrafts");
      return recorder.drafts;
    },
    agentReadingLedger: async () => {
      guardFail("agentReadingLedger");
      return recorder.ledger;
    },
    listAgents: async () => {
      guardFail("listAgents");
      return [{ id: "a1", name: "小林", channel: "codex" }];
    },
    l0FileChannelAgent: async () => {
      guardFail("l0FileChannelAgent");
      return "l0";
    },
    draftReviewTask: async () => {
      guardFail("draftReviewTask");
      return { id: "task-1" } as unknown as TaskDto;
    },
    previewDispatch: async () => {
      guardFail("previewDispatch");
      return preview("digest-abc123456789");
    },
    authorizeDispatch: async (request) => {
      guardFail("authorizeDispatch");
      recorder.authorized.push(request);
      return [run("r1", "authorized")];
    },
    launchRun: async () => {
      guardFail("launchRun");
      return null;
    },
    collectAttempt: async () => {
      guardFail("collectAttempt");
      return recorder.outcome;
    },
    retryRun: async () => {
      guardFail("retryRun");
      return run("r2", "queued");
    },
    cancelRun: async () => {
      guardFail("cancelRun");
      return null;
    },
    commitMaterialAction: async () => {
      guardFail("commitMaterialAction");
      return { path: "saved.md" } as unknown as DocumentRow;
    },
  };
  const session = new DispatchSession(
    gateway,
    context,
    {
      collected: (count) => recorder.collected.push(count),
      materialSaved: (row) => recorder.saved.push(row),
    },
    (error) => `失败:${String(error)}`,
  );
  return { session, recorder };
};

describe("DispatchSession 的票据", () => {
  test("五格都空时发不出去", () => {
    const { session } = rig();
    expect(session.view().cells.ready).toBe(false);
    expect(session.view().cells.scope).toBe("—");
  });

  test("范围、要求、伙伴三样齐了才算备妥", async () => {
    const { session } = rig();
    await session.start();
    session.touchRow(0, false);
    expect(session.view().cells.ready).toBe(false);
    session.proposePrompt("请检查这段的时序");
    expect(session.view().cells.ready).toBe(true);
    expect(session.view().cells.scope).toBe("1 块");
  });

  test("只有空白的要求不算要求", async () => {
    const { session } = rig();
    await session.start();
    session.touchRow(0, false);
    session.proposePrompt("   ");
    expect(session.view().cells.ready).toBe(false);
  });

  test("开场替作者选中第一个写作伙伴", async () => {
    const { session } = rig();
    await session.start();
    expect(session.view().model.agentId).toBe("a1");
    expect(session.view().model.agents.at(-1)?.label).toBe("手动往返");
  });

  test("按住 shift 点第二下，走过中间整段", () => {
    const { session } = rig();
    session.touchRow(0, false);
    session.touchRow(3, true);
    expect(session.view().model.selected).toEqual(["b1", "b2", "b3", "b4"]);
  });

  test("不按 shift 是逐块开合，再点一次就取消", () => {
    const { session } = rig();
    session.touchRow(1, false);
    session.touchRow(1, false);
    expect(session.view().model.selected).toEqual([]);
  });

  test("shift 走过已选的块不会把它重复记一次", () => {
    const { session } = rig();
    session.touchRow(2, false);
    session.touchRow(0, false);
    session.touchRow(2, true);
    expect(session.view().model.selected).toEqual(["b3", "b1", "b2"]);
  });

  test("换一份稿子会丢掉旧稿的选择", () => {
    const { session } = rig();
    session.touchRow(0, false);
    session.retarget({ ...context, path: "ch02.md" });
    expect(session.view().model.selected).toEqual([]);
    expect(session.view().model.phase.kind).toBe("editing");
  });
});

describe("DispatchSession 的发出与授权", () => {
  const ready = async () => {
    const found = rig();
    await found.session.start();
    found.session.touchRow(0, false);
    found.session.proposePrompt("请检查这段");
    return found;
  };

  test("发出先拿到清单，作者读过才谈得上授权", async () => {
    const { session } = await ready();
    await session.send();
    const manifest = session.view().manifest;
    expect(manifest).not.toBeNull();
    expect(manifest?.preview.digest).toBe("digest-abc123456789");
    expect(manifest?.reveal.kind).toBe("manifest");
  });

  test("没备妥就按发出，什么都不会过桥", async () => {
    const { session, recorder } = rig();
    await session.start();
    await session.send();
    expect(recorder.calls).not.toContain("draftReviewTask");
  });

  test("授权用的是作者读过的那份摘要", async () => {
    const { session, recorder } = await ready();
    await session.send();
    await session.authorize();
    expect(recorder.authorized[0]?.clickedDigest).toBe("digest-abc123456789");
    expect(session.view().model.phase.kind).toBe("dispatched");
  });

  test("要几份就派几路", async () => {
    const { session, recorder } = await ready();
    session.chooseCopies(3);
    await session.send();
    await session.authorize();
    expect(recorder.authorized[0]?.newAgents).toEqual(["a1", "a1", "a1"]);
  });

  test("授权之后每一路都真的启动了", async () => {
    const { session, recorder } = await ready();
    await session.send();
    await session.authorize();
    expect(recorder.calls).toContain("launchRun");
  });

  test("桥拒绝授权时留在原地，作者读得到原因", async () => {
    const { session, recorder } = await ready();
    await session.send();
    recorder.fail = "authorizeDispatch";
    await session.authorize();
    expect(session.view().activity.kind).toBe("failed");
    // 关键：没有假称已派发。
    expect(session.view().model.phase.kind).toBe("previewing");
  });

  test("再发一单会清掉范围与要求，但不动已发出的那单", async () => {
    const { session } = await ready();
    await session.send();
    await session.authorize();
    session.newTask();
    expect(session.view().model.selected).toEqual([]);
    expect(session.view().model.prompt).toBe("");
    expect(session.view().model.phase.kind).toBe("editing");
  });

  test("清单与原文两面可以来回翻", async () => {
    const { session } = await ready();
    await session.send();
    session.toggleReveal();
    expect(session.view().manifest?.reveal.kind).toBe("request");
    session.toggleReveal();
    expect(session.view().manifest?.reveal.kind).toBe("manifest");
  });

  test("没有清单的时候翻面没有含义，也不会出错", () => {
    const { session } = rig();
    session.toggleReveal();
    expect(session.view().manifest).toBeNull();
  });
});

describe("DispatchSession 的回收", () => {
  test("对方还没回，就说还没回，不报错", async () => {
    const { session } = rig();
    await session.collect(run("r1", "dispatched"));
    expect(session.view().activity).toEqual({ kind: "reported", text: "未回" });
  });

  test("收到提案会向上报数，让编辑区亮起来", async () => {
    const { session, recorder } = rig({
      outcome: {
        kind: "completed",
        value: { proposals: 4, drafts: 0 },
      } as unknown as CollectOutcomeDto,
    });
    await session.collect(run("r1", "dispatched"));
    expect(recorder.collected).toEqual([4]);
    expect(session.view().activity).toEqual({ kind: "reported", text: "已收 · 4 提案" });
  });

  test("失败的一次收取走失败那一支，不是措辞不同的告知", async () => {
    const { session, recorder } = rig({
      outcome: {
        kind: "failed",
        value: { code: "E_TIMEOUT" },
      } as unknown as CollectOutcomeDto,
    });
    await session.collect(run("r1", "dispatched"));
    expect(session.view().activity).toEqual({ kind: "failed", text: "失败 · E_TIMEOUT" });
    expect(recorder.collected).toEqual([]);
  });

  test("重发会重新过一遍清单，而不是照着旧摘要发", async () => {
    const { session } = rig();
    await session.start();
    session.proposePrompt("再看一次");
    const { calls } = (await (async () => {
      const found = rig();
      await found.session.start();
      found.session.touchRow(0, false);
      found.session.proposePrompt("再看一次");
      await found.session.retry(run("r1", "failed"));
      return found.recorder;
    })()) as Recorder;
    expect(calls).toContain("retryRun");
    expect(calls).toContain("previewDispatch");
  });
});

describe("DispatchSession 的锁与草稿", () => {
  test("正在忙的时候说得出在忙什么", async () => {
    const { session } = rig();
    const running = session.start();
    expect(session.view().activity).toEqual({ kind: "working", op: "load" });
    await running;
  });

  test("改草稿正文只动那一份草稿", () => {
    const { session } = rig();
    const draft = { id: "d1", body: "原文" } as unknown as MaterialDraftRow_Serialize;
    session.toggleDraftEdit(draft);
    session.editDraftBody("改过的");
    expect(session.view().draftBody).toEqual({ kind: "open", draftId: "d1", body: "改过的" });
    session.toggleDraftEdit(draft);
    expect(session.view().draftBody).toBeNull();
  });

  test("存下草稿会把新条目交给外面", async () => {
    const { session, recorder } = rig();
    const draft = { id: "d1", body: "原文" } as unknown as MaterialDraftRow_Serialize;
    session.toggleDraftEdit(draft);
    session.editDraftBody("改过的");
    await session.saveDraft(draft);
    expect(recorder.saved).toHaveLength(1);
    expect(session.view().draftBody).toBeNull();
  });

  test("在途的单子才值得回头看", async () => {
    const { session } = rig({
      hostState: host([run("r1", "dispatched")], [{ id: "task-1", document: "ch01.md" }]),
    });
    await session.start();
    expect(session.view().settling).toBe(true);
    expect(session.view().runs).toHaveLength(1);
  });

  test("全都落定之后就不必再回头看了", async () => {
    const { session } = rig({
      hostState: host([run("r1", "completed")], [{ id: "task-1", document: "ch01.md" }]),
    });
    await session.start();
    expect(session.view().settling).toBe(false);
  });

  test("别份稿子的单子不出现在这份稿子的日志里", async () => {
    const { session } = rig({
      hostState: host([run("r1", "completed", "task-9")], [{ id: "task-9", document: "ch99.md" }]),
    });
    await session.start();
    expect(session.view().runs).toEqual([]);
  });
});
