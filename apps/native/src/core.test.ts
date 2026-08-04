import { expect, test } from "bun:test";
import type { ScrollState } from "@native-sdk/core/events";
import { commandMsg, type Model, update } from "./core.ts";
import {
  ACTION_APPLY_INPUT,
  ACTION_OBTAIN_PROJECTION,
  ACTION_OPEN_MANUSCRIPT,
  ACTION_PROJECT,
  ERROR_UNKNOWN_SESSION,
  INPUT_SAVE,
  PROTOCOL_VERSION,
  RESPONSE_HEADER_BYTES,
} from "./generated/protocol.ts";

// The SDK packs leading scalars in field-name order; these mirror the
// offsets the generator publishes to Zig, so a renamed field fails here too.
const OFFSET_ACTION = 0;
const OFFSET_INPUT = 48;
const OFFSET_SCROLL_OFFSET_Y = 72;
const OFFSET_SESSION = 80;
const OFFSET_TEXT = 92;
const TRAILING_BYTES = 24;

const decoder = new TextDecoder();
const model: Model = {
  hostReady: true,
  status: new Uint8Array(0),
  protocolVersion: PROTOCOL_VERSION,
  documentSession: 7,
  documentRevision: 4,
  documentBytes: 11_953_418,
  documentBlocks: 99_997,
  documentScroll: 0,
  viewportFirstBlock: 0,
  projectionWindowStart: 0,
  projectResult: new Uint8Array(0),
  themeIndex: 0,
  destinationIndex: 0,
  paletteOpen: false,
  notice: new Uint8Array(0),
  noticeShown: false,
  rosterCount: 0,
  rosterCursor: -1,
  rootId: new Uint8Array(0),
  documentCursor: new Uint8Array(0),
  documentCount: 0,
  documentTotal: 0,
  searchQuery: new Uint8Array(0),
  searchExact: true,
  rosterHasRow: false,
  documentPath: new Uint8Array(0),
  revisingProposal: new Uint8Array(0),
  revisionText: new Uint8Array(0),
  dispatchPrompt: new Uint8Array(0),
  dispatchAgents: 1,
  dispatchOrchestration: 0,
};

test("undo enters the one host dispatch without optimistic document state", () => {
  const result = update(model, { kind: "document_undo" });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document undo did not return an effect");
  expect(result[0]).toBe(model);
});

test("save enters the one host dispatch without carrying a path", () => {
  const result = update(model, { kind: "document_save" });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document save did not return an effect");
  expect(result[0]).toBe(model);
  const command = result[1];
  if (command.op !== "request") throw new Error("document save did not issue the host request");
  expect(readF64(command.payload, OFFSET_ACTION)).toBe(ACTION_APPLY_INPUT);
  expect(readF64(command.payload, OFFSET_INPUT)).toBe(INPUT_SAVE);
  expect(command.payload.length).toBe(OFFSET_TEXT + TRAILING_BYTES);
});

test("text input enters the host dispatch without a TypeScript body copy", () => {
  const text = new TextEncoder().encode("確定入力");
  const result = update(model, {
    kind: "document_input",
    event: { kind: "set_composition", text, cursor: text.length },
  });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("composition did not return an effect");
  expect(result[0]).toBe(model);
  expect(Object.keys(result[0])).not.toContain("text");
  expect(Object.keys(result[0])).not.toContain("selection");
  expect(Object.keys(result[0])).not.toContain("composition");
});

test("scroll sends the real offset without optimistic viewport authority", () => {
  const offsetY = 1_799_675;
  const result = update(
    { ...model, documentBlocks: 100_000 },
    { kind: "document_scroll", scroll: scroll(offsetY, 650, 3_600_000) },
  );
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document scroll did not return an effect");
  expect(result[0].documentScroll).toBe(offsetY);
  expect(result[0].viewportFirstBlock).toBe(0);
  const command = result[1];
  if (command.op !== "request") throw new Error("document scroll did not issue the host request");
  expect(readF64(command.payload, OFFSET_SCROLL_OFFSET_Y)).toBe(offsetY);
});

test("the host projection response supplies the authoritative first block", () => {
  const response = responseBytes(ACTION_OBTAIN_PROJECTION, 0);
  writeU32(response, 20, model.documentSession);
  writeU32(response, 24, model.documentRevision);
  writeU32(response, 28, 11_953_766);
  writeU32(response, 32, 100_000);
  writeU32(response, 36, 5_976_883);
  writeU32(response, 40, 50_000);
  const result = update(model, { kind: "dispatch_ok", bytes: response });
  if (Array.isArray(result)) throw new Error("projection response unexpectedly returned an effect");
  expect(result.viewportFirstBlock).toBe(50_000);
  expect(result.projectionWindowStart).toBe(5_976_883);
});

test("one opaque Project input enters one group dispatch", () => {
  const input = new TextEncoder().encode('{"kind":"chooseAndAdoptRoot","value":{"kind":"folder"}}');
  const result = update(model, { kind: "project_request", input });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("project input did not return an effect");
  expect(result[0]).toBe(model);
  if (result[1].op !== "request") throw new Error("project input did not issue the host request");
  expect(readF64(result[1].payload, OFFSET_ACTION)).toBe(ACTION_PROJECT);
  expect(result[1].payload.slice(OFFSET_TEXT, OFFSET_TEXT + input.length)).toEqual(input);
});

test("choosing a theme records the index and refuses one outside the table", () => {
  // Model 只记下标：色值住在 generated/themes.zig，切主题因此是一次 Msg 而不是
  // 一次样式写入。越界回落到默认，而不是让界面停在无主题状态。
  // 选主题现在是两件事：立刻改 Model，并把它落盘——不落盘的话重开又回到濤，
  // 而作者会把那当成没保存成功。
  const result = update(model, { kind: "theme_select", index: 5 });
  if (!Array.isArray(result)) throw new Error("theme_select must persist the choice");
  const chosen = result[0];
  if (result[1].op !== "request") throw new Error("theme_select did not issue the host request");
  expect(readF64(result[1].payload, OFFSET_ACTION)).toBe(ACTION_PROJECT);
  expect(decoder.decode(result[1].payload.slice(OFFSET_TEXT)).includes('"setTheme":"sumi"')).toBe(
    true,
  );
  expect(chosen.themeIndex).toBe(5);

  // 极值：两端外、非整数、NaN 都回落到默认，并且落盘的也是默认那一套——
  // 一次坏的选择不该把设置写成一个不存在的主题。
  for (const bad of [-1, 7, 1.5, Number.NaN]) {
    const fallback = update(chosen, { kind: "theme_select", index: bad });
    if (!Array.isArray(fallback)) throw new Error("theme_select must persist the fallback");
    expect(fallback[0].themeIndex).toBe(0);
    if (fallback[1].op !== "request") throw new Error("fallback did not issue the host request");
    expect(
      decoder.decode(fallback[1].payload.slice(OFFSET_TEXT)).includes('"setTheme":"tou"'),
    ).toBe(true);
  }
});

test("opening a chosen document sends a Root reference, not a filesystem path", () => {
  // Step 4: the production open route. The reference is `rootId\npath`, so the
  // request carries no absolute path — Rust resolves it inside the Root.
  const reference = new TextEncoder().encode("root-1\n\u7ae0.md");
  const result = update(model, { kind: "document_open", reference });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document_open did not return an effect");
  if (result[1].op !== "request") throw new Error("document_open did not issue the host request");
  expect(readF64(result[1].payload, OFFSET_ACTION)).toBe(ACTION_OPEN_MANUSCRIPT);
  expect(result[1].payload.slice(OFFSET_TEXT, OFFSET_TEXT + reference.length)).toEqual(reference);
  // A fresh open starts a new session rather than reusing the current one.
  expect(readF64(result[1].payload, OFFSET_SESSION)).toBe(0);
  // 记住打开的是哪一份：裁决与提案读取都以它为作用域。存的是换行之后
  // 那一段——把整个引用存下来，请求里的 path 就会带上 Root id。
  expect(new TextDecoder().decode(result[0].documentPath)).toBe("\u7ae0.md");
});

test("one Project response remains an immutable Rust projection", () => {
  const payload = new TextEncoder().encode('{"kind":"cancelled"}');
  const result = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, payload),
  });
  if (Array.isArray(result)) throw new Error("project response unexpectedly returned an effect");
  expect(result.projectResult).toEqual(payload);
  expect(result.documentRevision).toBe(model.documentRevision);
  expect(result.documentBytes).toBe(model.documentBytes);
});

test("typed dispatch failure keeps the Rust boundary visible", () => {
  const response = responseBytes(ACTION_APPLY_INPUT, ERROR_UNKNOWN_SESSION);
  const result = update(model, { kind: "dispatch_err", bytes: response });
  if (Array.isArray(result)) throw new Error("dispatch failure returned an effect");
  expect(decoder.decode(result.status)).toBe("Native document session was unknown.");
});

test("project facts land the Root and settle the cursor into the new roster", () => {
  // 这是名录活过来的那一步：此前 `rosterCount` 没有任何写入点，四个去处
  // 因此永远显示空——规则、通道、Rust 用例都在，缺的正是这条落地。
  const rootId = new TextEncoder().encode("root-1");
  const cursor = new TextEncoder().encode("十.md");
  const listed: Model = { ...model, rosterCount: 5, rosterCursor: 4 };
  const landed = update(listed, {
    kind: "project_facts",
    rootId,
    documentCursor: cursor,
    documentCount: 12,
    documentTotal: 40,
    rosterCount: 2,
  }) as Model;
  expect(landed.rootId).toEqual(rootId);
  expect(landed.documentCursor).toEqual(cursor);
  expect(landed.documentCount).toBe(12);
  expect(landed.documentTotal).toBe(40);
  expect(landed.rosterCount).toBe(2);
  // 名录变短后游标必须留在名录里。停在最近的一端而不是弹回第一行——
  // 收走末行时作者的注意力在末尾。
  expect(landed.rosterCursor).toBe(1);
  // 名录空了要交出 NO_ROW，不是 0：0 是一个真实的行，动作会落在它上面。
  const emptied = update(landed, {
    kind: "project_facts",
    rootId,
    documentCursor: new Uint8Array(0),
    documentCount: 0,
    documentTotal: 0,
    rosterCount: 0,
  }) as Model;
  expect(emptied.rosterCursor).toBe(-1);
});

test("a reply without a Root keeps the one the author already opened", () => {
  // 近失手：读设置与推进 KARA 的答复不带 Root。把空当成「Root 没了」，
  // 作者的项目会在一次读设置之后从界面上消失。
  const rootId = new TextEncoder().encode("root-1");
  const opened: Model = { ...model, rootId };
  const settings = update(opened, {
    kind: "project_facts",
    rootId: new Uint8Array(0),
    documentCursor: new Uint8Array(0),
    documentCount: 0,
    documentTotal: 0,
    rosterCount: 0,
  }) as Model;
  expect(settings.rootId).toEqual(rootId);
});

test("the search box deletes whole characters, not bytes", () => {
  // 按字节退会把一个汉字拆成半个：剩下的字节不是合法 UTF-8，Rust 会具名
  // 拒绝整条请求，而作者读成的是「搜索坏了」。
  const encoder = new TextEncoder();
  const typed = update(model, {
    kind: "search_typed",
    event: { kind: "insert_text", text: encoder.encode("克制") },
  }) as Model;
  expect(new TextDecoder().decode(typed.searchQuery)).toBe("克制");

  const backspaced = update(typed, {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  }) as Model;
  // 一个汉字是三个字节：退一次必须剩下完整的「克」，不是「克」加两个字节。
  expect(new TextDecoder().decode(backspaced.searchQuery)).toBe("克");
  expect(backspaced.searchQuery.length).toBe(3);

  // ASCII 也要对：退一个字节正好是一个字符。
  const ascii = update(model, {
    kind: "search_typed",
    event: { kind: "insert_text", text: encoder.encode("ab") },
  }) as Model;
  const cut = update(ascii, {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  }) as Model;
  expect(new TextDecoder().decode(cut.searchQuery)).toBe("a");

  // 极值：空框上退格留在空，不越界。
  const empty = update(model, {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  }) as Model;
  expect(empty.searchQuery.length).toBe(0);

  // 清空就是清空。
  const cleared = update(typed, { kind: "search_typed", event: { kind: "clear" } }) as Model;
  expect(cleared.searchQuery.length).toBe(0);
});

test("search precision is the author's choice, not a hidden default", () => {
  expect(model.searchExact).toBe(true);
  const loose = update(model, { kind: "search_precision" }) as Model;
  expect(loose.searchExact).toBe(false);
  expect((update(loose, { kind: "search_precision" }) as Model).searchExact).toBe(true);
});

function scroll(offsetY: number, viewportExtentY: number, contentExtentY: number): ScrollState {
  return {
    offsetX: 0,
    offsetY,
    velocityX: 0,
    velocityY: 0,
    viewportExtentX: 1000,
    viewportExtentY,
    contentExtentX: 1000,
    contentExtentY,
  };
}

function responseBytes(
  action: number,
  status: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  // 头部长度从生成协议读，不写字面量：协议加字段时头部会变长，
  // 而一个写死 52 的夹具会在两侧都自洽的情况下静默构造出坏响应。
  const response = new Uint8Array(RESPONSE_HEADER_BYTES + payload.length);
  response.set(new Uint8Array([82, 70, 82, 78]), 0);
  writeU16(response, 4, PROTOCOL_VERSION);
  writeU16(response, 6, action);
  writeU32(response, 8, status);
  writeU32(response, 48, payload.length);
  response.set(payload, RESPONSE_HEADER_BYTES);
  return response;
}

function readF64(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, true);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 256) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  let remaining = value;
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}

test("a destination that reads the manuscript refuses when none is open and says so", () => {
  const closed: Model = { ...model, documentSession: 0 };
  const refused = update(closed, { kind: "workbench_key", ordinal: 3 }) as Model;
  // 拒绝要留痕：去处不动，但作者看得见原因。
  expect(refused.destinationIndex).toBe(0);
  expect(decoder.decode(refused.notice)).toBe("Open a manuscript first.");

  const allowed = update(model, { kind: "workbench_key", ordinal: 3 }) as Model;
  expect(allowed.destinationIndex).toBe(2);
  expect(allowed.notice.length).toBe(0);
});

test("a key outside the destination list leaves the model untouched", () => {
  // 近失手：把非导航键也当成一次导航，会清掉正待读的提示。
  const noticed = update(
    { ...model, documentSession: 0 },
    {
      kind: "workbench_key",
      ordinal: 3,
    },
  ) as Model;
  expect(update(noticed, { kind: "workbench_key", ordinal: 99 })).toBe(noticed);
  expect(update(noticed, { kind: "workbench_key", ordinal: 0 })).toBe(noticed);
});

test("losing the manuscript evicts a destination that was reading it", () => {
  const reviewing = update(model, { kind: "workbench_go", index: 2 }) as Model;
  expect(reviewing.destinationIndex).toBe(2);

  // 一次 session 归零的响应（换项目、关文档）必须把作者带回稿子。
  const closed = update(reviewing, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_OBTAIN_PROJECTION, 0),
  }) as Model;
  expect(closed.documentSession).toBe(0);
  expect(closed.destinationIndex).toBe(0);

  // 极值对照：session 非零时不驱逐——否则每次投影回来都会把作者踢回稿子。
  const alive = responseBytes(ACTION_OBTAIN_PROJECTION, 0);
  writeU32(alive, 20, 7);
  expect((update(reviewing, { kind: "dispatch_ok", bytes: alive }) as Model).destinationIndex).toBe(
    2,
  );
});

test("the command palette floats above the destination instead of replacing it", () => {
  const opened = update(model, { kind: "palette_toggle" }) as Model;
  expect(opened.paletteOpen).toBe(true);
  expect(opened.destinationIndex).toBe(model.destinationIndex);
  // 选中一个去处之后面板让开——它的用途已经完成。
  const chosen = update(opened, { kind: "workbench_go", index: 1 }) as Model;
  expect(chosen.paletteOpen).toBe(false);
  expect(chosen.destinationIndex).toBe(1);
});

test("every declared shortcut id maps to a message, and an unknown one is refused", () => {
  // 快捷键与系统菜单共用这一个入口，所以 `app.zon` 里声明的每一个 id 都
  // 必须在这里有落点——漏一个的表现是按下去毫无反应，而两边单看都自洽。
  for (const [name, kind] of [
    ["go.1", "workbench_key"],
    ["go.8", "workbench_key"],
    ["palette", "palette_toggle"],
    ["roster.next", "roster_step"],
    ["roster.previous", "roster_step"],
    ["document.save", "document_save"],
    ["document.undo", "document_undo"],
    ["theme.next", "theme_next"],
    ["app.quit", "app_quit"],
  ] as const) {
    expect(commandMsg(name)?.kind).toBe(kind);
  }
  // 八个去处直达键都要落到对应的序号上。
  expect(commandMsg("go.3")).toEqual({ kind: "workbench_key", ordinal: 3 });
  // 名录上下是同一条消息的两个方向，不是两条消息。
  expect(commandMsg("roster.previous")).toEqual({ kind: "roster_step", delta: -1 });
  // 近失手：不认识的 id 必须返回 null 让 SDK 忽略，而不是猜一个默认动作。
  expect(commandMsg("go.9")).toBeNull();
  expect(commandMsg("")).toBeNull();
});

test("quit hands shutdown to the host without touching the model", () => {
  // 录制会话靠这条命令封口 journal：`quitApp` 走最后一扇窗关闭的同一条
  // 收尾链。没有它，进程只能被信号杀掉，而回放会判 `JournalTruncated`。
  const [next, cmd] = update(model, { kind: "app_quit" }); // 模型必须原样返回：退出不是一次状态迁移。
  expect(next).toEqual(model);
  expect(cmd).toEqual({ op: "quit_app" });
});

test("quit does not save on the author's behalf", () => {
  // 近失手：只差一个条件——若退出顺手落盘，一次误按就会静默盖掉作者
  // 尚未确认的改动。保存归 `document.save`，两条命令不得合并。
  const dirty: Model = { ...model, documentRevision: 7 };
  const [, cmd] = update(dirty, { kind: "app_quit" });
  expect(cmd).toEqual({ op: "quit_app" });
  // 极端：脏稿子也一样，不得挟带任何主机请求。
  expect(JSON.stringify(cmd)).not.toContain("refrain.host");
});

test("changing destination clears the roster instead of inheriting the last one", () => {
  // 名录属于去处。留着上一处的计数，界面会画一列并不存在的行，而游标
  // 停在其中一行上——作者按下动作键时那一行指向别的去处的东西。
  const listed: Model = { ...model, rosterCount: 5, rosterCursor: 3 };
  const moved = update(listed, { kind: "workbench_go", index: 1 }) as Model;
  expect(moved.rosterCount).toBe(0);
  expect(moved.rosterCursor).toBe(-1);
});

test("the roster cursor moves under one invariant and never leaves the roster", () => {
  const listed: Model = { ...model, rosterCount: 3, rosterCursor: 0 };
  expect((update(listed, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(1);
  // 撞到两端就停，不绕回：绕回会让按住方向键变成无限循环。
  expect((update(listed, { kind: "roster_step", delta: -1 }) as Model).rosterCursor).toBe(0);
  const last: Model = { ...listed, rosterCursor: 2 };
  expect((update(last, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(2);
  // 近失手：空名录上移动必须留在 NO_ROW，不能落到 0——0 是一个真实的行。
  const empty: Model = { ...model, rosterCount: 0, rosterCursor: -1 };
  expect((update(empty, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(-1);
});

test("a revision starts from the agent's suggestion, not from a blank page", () => {
  // 起点是建议而不是空白：作者多数时候只改一两个词。从空白开始等于让他
  // 重打一遍，那把「改写」变成了「拒绝后自己重写」——两件不同的事。
  const seeded = update(model, {
    kind: "revision_begin",
    proposalId: new TextEncoder().encode("p7.s8"),
    seed: new TextEncoder().encode("the agent's wording"),
  }) as Model;
  expect(new TextDecoder().decode(seeded.revisingProposal)).toBe("p7.s8");
  expect(new TextDecoder().decode(seeded.revisionText)).toBe("the agent's wording");
});

test("typing outside a revision changes nothing", () => {
  // 近失手：少了这条守卫，一次落错地方的按键会凭空开始一段没有归属的
  // 改写，而它要到提交时才被 Rust 拒绝——失败离动作很远。
  const typed = update(model, {
    kind: "revision_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("x") },
  }) as Model;
  expect(typed.revisionText.length).toBe(0);
  expect(typed.revisingProposal.length).toBe(0);
});

test("backspace in a revision deletes a whole character, not a byte", () => {
  // 按字节退会把一个汉字拆成半个，剩下的字节不是合法 UTF-8，Rust 那边
  // 具名拒绝整条裁决——而作者只是按了一下退格。
  const started = update(model, {
    kind: "revision_begin",
    proposalId: new TextEncoder().encode("p1.s1"),
    seed: new TextEncoder().encode("剑更稳"),
  }) as Model;
  const back = update(started, {
    kind: "revision_typed",
    event: { kind: "delete_backward" },
  }) as Model;
  expect(new TextDecoder().decode(back.revisionText)).toBe("剑更");
});

test("cancelling a revision clears both fields together", () => {
  // 只清 id 会留下一段孤立的文字，下次改写时它作为起点冒出来，作者读到的
  // 是「上一条的字漏进来了」。
  const started = update(model, {
    kind: "revision_begin",
    proposalId: new TextEncoder().encode("p1.s1"),
    seed: new TextEncoder().encode("draft"),
  }) as Model;
  const cancelled = update(started, { kind: "revision_cancel" }) as Model;
  expect(cancelled.revisingProposal.length).toBe(0);
  expect(cancelled.revisionText.length).toBe(0);
});

test("switching proposals abandons the half-written revision", () => {
  // 那段文字是针对上一条提案的。留着它，作者会把 A 的改写提交到 B 上——
  // 而两条提案的界面看起来一模一样。
  const first = update(model, {
    kind: "revision_begin",
    proposalId: new TextEncoder().encode("p1.s1"),
    seed: new TextEncoder().encode("first draft"),
  }) as Model;
  const second = update(first, {
    kind: "revision_begin",
    proposalId: new TextEncoder().encode("p2.s4"),
    seed: new TextEncoder().encode("second suggestion"),
  }) as Model;
  expect(new TextDecoder().decode(second.revisingProposal)).toBe("p2.s4");
  expect(new TextDecoder().decode(second.revisionText)).toBe("second suggestion");
});

test("the agent count stays in a range a real dispatch can serve", () => {
  // 零个 agent 铸不出 Run：作者会看到一行永远等待的 Task，而没有任何东西
  // 在跑。上限是因为并列的 Run 各跑一个真实进程。
  const one = update(model, { kind: "dispatch_agents", delta: -1 }) as Model;
  expect(one.dispatchAgents).toBe(1);
  let many: Model = model;
  for (let step = 0; step < 8; step += 1) {
    many = update(many, { kind: "dispatch_agents", delta: 1 }) as Model;
  }
  expect(many.dispatchAgents).toBe(4);
});

test("the dispatch prompt and the revision draft do not share one buffer", () => {
  // 两块草稿共用编辑规则，但各存各的字节。合成一个，作者写到一半切去
  // 裁决台，回来会发现请求变成了别的东西。
  const prompt = update(model, {
    kind: "dispatch_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("改克制些") },
  }) as Model;
  expect(new TextDecoder().decode(prompt.dispatchPrompt)).toBe("改克制些");
  expect(prompt.revisionText.length).toBe(0);
});

test("the orchestration cycles through all three and never leaves the table", () => {
  // 三种排法循环。落到表外的下标会让 Zig 侧查表回落，而作者看到的是
  // 按了一下没反应——他会以为这个按钮坏了，而不是自己转了一圈。
  let current: Model = model;
  const seen: number[] = [current.dispatchOrchestration];
  for (let step = 0; step < 3; step += 1) {
    current = update(current, { kind: "dispatch_orchestration" }) as Model;
    seen.push(current.dispatchOrchestration);
  }
  expect(seen).toEqual([0, 1, 2, 0]);
});
