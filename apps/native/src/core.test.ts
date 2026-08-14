import { expect, test } from "bun:test";
import type { ScrollState } from "@native-sdk/core/events";
import { commandMsg, frameMsg, keyMsg, type Model, update as updateCore } from "./core.ts";
import {
  ACTION_APPLY_INPUT,
  ACTION_HEALTH,
  ACTION_OBTAIN_PROJECTION,
  ACTION_OPEN_MANUSCRIPT,
  ACTION_PROJECT,
  API_VERSION,
  CAPABILITY_MASK,
  ERROR_UNKNOWN_SESSION,
  INPUT_SAVE,
  PROTOCOL_VERSION,
  RESPONSE_HEADER_BYTES,
} from "./generated/protocol.ts";

// update 恒返 [Model, Cmd<Msg>]（编译车道没有混形糖，见 core.ts 签名注）。
// 这套测试写于混形年代，读法随臂而异：裸 Model（result.status）、元组
// （result[0]/result[1]）、引用同一性（toBe(model)）、还把返回值喂回
// update。适配器按旧糖的原义还原混形——Cmd.none 剥壳回裸 Model，真效果
// 保留元组——170 个调用点的语义与迁移前逐字相同。
function update(model: Model, msg: Parameters<typeof updateCore>[1]): Model {
  const out = updateCore(model, msg);
  return (out[1].op === "none" ? out[0] : out) as unknown as Model;
}

// 效果有无的断言：适配器还原了混形，「这一臂产生了效果」等于拿到了元组。
function hasEffect(r: unknown): boolean {
  return Array.isArray(r);
}

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
  savePending: false,
  savedRevision: 4,
  documentScroll: 0,
  viewportFirstBlock: 0,
  projectionWindowStart: 0,
  projectResult: new Uint8Array(0),
  themeIndex: 0,
  panelMaterial: 0,
  destinationIndex: 0,
  panelStack: 0,
  agentDestination: 3,
  railPeek: 0,
  railFraction: 0.19,
  layoutFraction: 1,
  typographyTextSize: 17,
  typographyLineHeightPercent: 190,
  typographyMeasureEm: 65,
  karaState: 0,
  karaQueued: 0,
  karaCard: false,
  karaReturnTail: new Uint8Array(0),
  karaInterrupt: new Uint8Array(0),
  pendingJumpBlock: -1,
  verdictProposal: new Uint8Array(0),
  verdictAccept: new Uint8Array(0),
  verdictReject: new Uint8Array(0),
  verdictSeed: new Uint8Array(0),
  reviewPeer: 0,
  reviewReason: new Uint8Array(0),
  reasonRecorded: false,
  reasonOpen: false,
  reasonDraft: new Uint8Array(0),
  staleFrozen: new Uint8Array(0),
  staleRecovery: new Uint8Array(0),
  stagedCount: 0,
  reviewAdvanceArmed: false,
  documentColumnsEm: 65,
  documentViewportHeight: 0,
  windowWidth: 0,
  windowHeight: 0,
  paletteOpen: false,
  paletteQuery: new Uint8Array(0),
  notice: new Uint8Array(0),
  noticeShown: false,
  rosterCount: 0,
  rosterCursor: -1,
  rootId: new Uint8Array(0),
  documentCursor: new Uint8Array(0),
  documentTotal: 0,
  searchQuery: new Uint8Array(0),
  searchExact: true,
  mailboxDiscarded: false,
  rosterHasRow: false,
  documentPath: new Uint8Array(0),
  revisingProposal: new Uint8Array(0),
  revisionText: new Uint8Array(0),
  dispatchPrompt: new Uint8Array(0),
  configReply: new Uint8Array(0),
  deskHost: new Uint8Array(0),
  deskPreview: new Uint8Array(0),
  materialDraftId: new Uint8Array(0),
  materialDraftText: new Uint8Array(0),
  deskMaterials: new Uint8Array(0),
  dispatchMaterials: new Uint8Array(0),
  deskBlocks: new Uint8Array(0),
  deskBlocksNext: -1,
  dispatchChecked: new Uint8Array(0),
  dispatchCarry: 0,
  dispatchAgent: new Uint8Array(0),
  dispatchStash: new Uint8Array(0),
  annotationDraft: new Uint8Array(0),
  editingAgent: new Uint8Array(0),
  agentArgvDraft: new Uint8Array(0),
  dispatchAgents: 1,
  dispatchOrchestration: 0,
};

test("undo enters the one host dispatch without optimistic document state", () => {
  const result = update(model, { kind: "document_undo" });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("document undo did not return an effect");
  expect(result[0]).toBe(model);
});

test("save enters the one host dispatch without carrying a path", () => {
  const result = update(model, { kind: "document_save" });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("document save did not return an effect");
  // 2.6 起保存在答复回来前立着在飞标记（状态行「正在保存…」），其余不变。
  expect(result[0].savePending).toBe(true);
  expect(result[0].documentRevision).toBe(model.documentRevision);
  const command = result[1];
  if (command.op !== "request") throw new Error("document save did not issue the host request");
  expect(readF64(command.payload, OFFSET_ACTION)).toBe(ACTION_APPLY_INPUT);
  expect(readF64(command.payload, OFFSET_INPUT)).toBe(INPUT_SAVE);
  expect(command.payload.length).toBe(OFFSET_TEXT + TRAILING_BYTES);
});

test("a save flies pending and its reply marks the save point", () => {
  // 保存走自己的通道键与两臂：答复落地前 savePending 立着（状态行「正在
  // 保存…」），答复落地后保存点盖到答复的 revision——「已保存」只认这份
  // 正面证据。
  const saving = update(model, { kind: "document_save" });
  if (!hasEffect(saving)) throw new Error("document save did not return an effect");
  expect(saving[0].savePending).toBe(true);
  const reply = responseBytes(ACTION_APPLY_INPUT, 0);
  writeU32(reply, 20, 7); // session
  writeU32(reply, 24, 5); // revision
  const saved = update(saving[0], { kind: "save_ok", bytes: reply });
  if (hasEffect(saved)) throw new Error("a plain save reply unexpectedly chained an effect");
  expect(saved.savePending).toBe(false);
  expect(saved.documentRevision).toBe(5);
  expect(saved.savedRevision).toBe(5);
});

test("a typing reply after the save leaves the save point behind", () => {
  // 打字把 revision 推到 6 而保存点停在 5：状态行据此说「有未保存改动」，
  // 而不是靠「上一次请求是什么」猜。
  const saved: Model = { ...model, documentRevision: 5, savedRevision: 5 };
  const typed = responseBytes(ACTION_APPLY_INPUT, 0);
  writeU32(typed, 20, 7);
  writeU32(typed, 24, 6);
  const landed = update(saved, { kind: "dispatch_ok", bytes: typed });
  if (hasEffect(landed)) throw new Error("a typing reply unexpectedly chained an effect");
  expect(landed.documentRevision).toBe(6);
  expect(landed.savedRevision).toBe(5);
});

test("a failed save clears the flight flag without marking anything saved", () => {
  const result = update(
    { ...model, savePending: true },
    { kind: "save_err", bytes: responseBytes(ACTION_APPLY_INPUT, 1) },
  );
  if (hasEffect(result)) throw new Error("a save failure unexpectedly chained an effect");
  expect(result.savePending).toBe(false);
  expect(result.savedRevision).toBe(model.savedRevision);
});

test("text input enters the host dispatch without a TypeScript body copy", () => {
  const text = new TextEncoder().encode("確定入力");
  const result = update(model, {
    kind: "document_input",
    event: { kind: "set_composition", text, cursor: text.length },
  });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("composition did not return an effect");
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
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("document scroll did not return an effect");
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
  if (hasEffect(result)) throw new Error("projection response unexpectedly returned an effect");
  expect(result.viewportFirstBlock).toBe(50_000);
  expect(result.projectionWindowStart).toBe(5_976_883);
});

test("one opaque Project input enters one group dispatch", () => {
  const input = new TextEncoder().encode('{"kind":"chooseAndAdoptRoot","value":{"kind":"folder"}}');
  const result = update(model, { kind: "project_request", input });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("project input did not return an effect");
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
  if (!hasEffect(result)) throw new Error("theme_select must persist the choice");
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
    if (!hasEffect(fallback)) throw new Error("theme_select must persist the fallback");
    expect(fallback[0].themeIndex).toBe(0);
    if (fallback[1].op !== "request") throw new Error("fallback did not issue the host request");
    expect(
      decoder.decode(fallback[1].payload.slice(OFFSET_TEXT)).includes('"setTheme":"tou"'),
    ).toBe(true);
  }
});

test("a noop leaves the model untouched by reference", () => {
  // 排版滑杆没跨过一个步距时 Zig 送 noop：落地必须是「什么都不做」——
  // 引用不变地返回，界面不会因此多重建一次。
  const result = update(model, { kind: "noop" });
  expect(hasEffect(result)).toBe(false);
  if (hasEffect(result)) throw new Error("noop must not issue an effect");
  expect(result).toBe(model);
});

test("opening a chosen document sends a Root reference, not a filesystem path", () => {
  // Step 4: the production open route. The reference is `rootId\npath`, so the
  // request carries no absolute path — Rust resolves it inside the Root.
  const reference = new TextEncoder().encode("root-1\n\u7ae0.md");
  const result = update(model, { kind: "document_open", reference });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("document_open did not return an effect");
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
  if (hasEffect(result)) throw new Error("project response unexpectedly returned an effect");
  expect(result.projectResult).toEqual(payload);
  expect(result.documentRevision).toBe(model.documentRevision);
  expect(result.documentBytes).toBe(model.documentBytes);
});

test("typed dispatch failure keeps the Rust boundary visible", () => {
  const response = responseBytes(ACTION_APPLY_INPUT, ERROR_UNKNOWN_SESSION);
  const result = update(model, { kind: "dispatch_err", bytes: response });
  if (hasEffect(result)) throw new Error("dispatch failure returned an effect");
  expect(decoder.decode(result.status)).toBe("Native document session was unknown.");
});

test("a reply without a Root keeps the one the author already opened", () => {
  // 近失手：读设置与推进 KARA 的答复不带 Root。把空当成「Root 没了」，
  // 作者的项目会在一次读设置之后从界面上消失。（落地路径版：project_facts
  // 臂删除后，这是 dispatch_ok 落地的同款覆盖。）
  const rootId = new TextEncoder().encode("root-1");
  const opened: Model = { ...model, rootId };
  const json = new TextEncoder().encode('{"kind":"config","value":{"appearance":{}}}');
  const landed = update(opened, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, json),
  }) as Model;
  expect(landed.rootId).toEqual(rootId);
});

test("the search box deletes whole characters, not bytes", () => {
  // 按字节退会把一个汉字拆成半个：剩下的字节不是合法 UTF-8，Rust 会具名
  // 拒绝整条请求，而作者读成的是「搜索坏了」。
  const encoder = new TextEncoder();
  const typedResult = update(model, {
    kind: "search_typed",
    event: { kind: "insert_text", text: encoder.encode("克制") },
  });
  // 2.4 起 typing 挂防抖钟，返回带 Cmd 的对子。
  if (!hasEffect(typedResult)) throw new Error("typing did not arm the debounce");
  const typed = typedResult[0];
  expect(new TextDecoder().decode(typed.searchQuery)).toBe("克制");

  const backspacedResult = update(typed, {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  });
  if (!hasEffect(backspacedResult)) throw new Error("backspace did not re-arm");
  const backspaced = backspacedResult[0];
  // 一个汉字是三个字节：退一次必须剩下完整的「克」，不是「克」加两个字节。
  expect(new TextDecoder().decode(backspaced.searchQuery)).toBe("克");
  expect(backspaced.searchQuery.length).toBe(3);

  // ASCII 也要对：退一个字节正好是一个字符。
  const asciiResult = update(model, {
    kind: "search_typed",
    event: { kind: "insert_text", text: encoder.encode("ab") },
  });
  if (!hasEffect(asciiResult)) throw new Error("typing did not arm");
  const cutResult = update(asciiResult[0], {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  });
  if (!hasEffect(cutResult)) throw new Error("backspace did not re-arm");
  expect(new TextDecoder().decode(cutResult[0].searchQuery)).toBe("a");

  // 极值：空框上退格留在空，不越界（空查询回 idle：撤钟）。
  const emptyResult = update(model, {
    kind: "search_typed",
    event: { kind: "delete_backward" },
  });
  if (!hasEffect(emptyResult)) throw new Error("an empty box did not cancel");
  expect(emptyResult[0].searchQuery.length).toBe(0);
  expect(emptyResult[1].op).toBe("cancel");

  // 清空就是清空。
  const clearedResult = update(typed, { kind: "search_typed", event: { kind: "clear" } });
  if (!hasEffect(clearedResult)) throw new Error("clear did not cancel");
  const cleared = clearedResult[0];
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
  // Cmd+4 = Agent 区，默认落点派发——派发需要稿子。
  const refused = update(closed, { kind: "workbench_key", ordinal: 4 }) as Model;
  // 拒绝要留痕：去处不动，但作者看得见原因。
  expect(refused.destinationIndex).toBe(0);
  expect(decoder.decode(refused.notice)).toBe("先打开一份稿子。");

  const allowed = update(model, { kind: "workbench_key", ordinal: 4 }) as Model;
  expect(allowed.destinationIndex).toBe(3);
  expect(allowed.notice.length).toBe(0);
});

test("a key outside the destination list leaves the model untouched", () => {
  // 近失手：把非导航键也当成一次导航，会清掉正待读的提示。
  const noticed = update(
    { ...model, documentSession: 0 },
    {
      kind: "workbench_key",
      ordinal: 4,
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
    ["search", "workbench_key"],
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
  // 游标只在有名录的去处上移动（裁决台下标 2 进栈底 = 栈顶是裁决台）。
  const listed: Model = { ...model, panelStack: 2, rosterCount: 3, rosterCursor: 0 };
  expect((update(listed, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(1);
  // 撞到两端就停，不绕回：绕回会让按住方向键变成无限循环。
  expect((update(listed, { kind: "roster_step", delta: -1 }) as Model).rosterCursor).toBe(0);
  const last: Model = { ...listed, rosterCursor: 2 };
  expect((update(last, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(2);
  // 近失手：空名录上移动必须留在 NO_ROW，不能落到 0——0 是一个真实的行。
  const empty: Model = { ...model, panelStack: 2, rosterCount: 0, rosterCursor: -1 };
  expect((update(empty, { kind: "roster_step", delta: 1 }) as Model).rosterCursor).toBe(-1);
});

test("roster keys stay still where no roster lives", () => {
  // 没有名录的去处（栈底 0 = 稿子）上移动一个看不见的游标，等作者回到
  // 台上时位置已经漂了——所以键在那里不生效。
  const listed: Model = { ...model, panelStack: 0, rosterCount: 3, rosterCursor: 0 };
  const still = update(listed, { kind: "roster_step", delta: 1 }) as Model;
  expect(still.rosterCursor).toBe(0);
});

test("moving the roster cursor flips the competing draft back to side A", () => {
  const listed: Model = { ...model, panelStack: 2, rosterCount: 3, rosterCursor: 0, reviewPeer: 1 };
  const moved = update(listed, { kind: "roster_step", delta: 1 }) as Model;
  expect(moved.reviewPeer).toBe(0);
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

test("escape walks back through the destinations it came from, then stops", () => {
  // 旧版面板栈的 back()：退一步，而不是把整棵路径关掉。
  // 近失手：退层也更新「上一个去处」的话，连按两次 Escape 会原地打转。
  let current: Model = model; // 稿子
  current = update(current, { kind: "workbench_key", ordinal: 2 }) as Model; // 文件
  current = update(current, { kind: "workbench_key", ordinal: 4 }) as Model; // 派发
  current = update(current, { kind: "workbench_key", ordinal: 6 }) as Model; // 连接
  expect(current.destinationIndex).toBe(5);

  current = update(current, { kind: "panel_back" }) as Model;
  expect(current.destinationIndex).toBe(3); // 派发
  current = update(current, { kind: "panel_back" }) as Model;
  expect(current.destinationIndex).toBe(1); // 文件
  current = update(current, { kind: "panel_back" }) as Model;
  expect(current.destinationIndex).toBe(0); // 稿子
  const still = update(current, { kind: "panel_back" }) as Model;
  expect(still.destinationIndex).toBe(0); // 到头了，原地不动
});

test("same-key-again closes the top layer and reveals the one beneath", () => {
  // 2.9 多层语义：同键再按关的是最上层，下面那层露出来（不是直接回稿子）。
  let current: Model = model;
  current = update(current, { kind: "workbench_key", ordinal: 4 }) as Model; // 派发
  current = update(current, { kind: "workbench_key", ordinal: 1 }) as Model; // 设置
  expect(current.destinationIndex).toBe(7);
  current = update(current, { kind: "workbench_key", ordinal: 1 }) as Model; // 同键关闭设置
  expect(current.destinationIndex).toBe(3); // 派发露出来
  const still = update(current, { kind: "panel_back" }) as Model; // 栈已空，退到稿子
  expect(still.destinationIndex).toBe(0);
  // 想回派发按 ⌘4（Agent 记忆）。
  const back = update(still, { kind: "workbench_key", ordinal: 4 }) as Model;
  expect(back.destinationIndex).toBe(3);
});

test("the rail fraction is owned by the model and survives navigation", () => {
  // 只认文件区的拖动（面板开合的 tween echo 不是作者意图）。
  const atFiles = update(model, { kind: "workbench_key", ordinal: 2 }) as Model;
  const dragged = update(atFiles, { kind: "split_resize", fraction: 0.33 }) as Model;
  expect(dragged.railFraction).toBe(0.33);
  // 面板去处里来的 resize echo 被拒绝（不污染侧栏宽）。
  const atPanel = update(dragged, { kind: "workbench_key", ordinal: 1 }) as Model;
  const echoed = update(atPanel, { kind: "split_resize", fraction: 0.5 }) as Model;
  expect(echoed.railFraction).toBe(0.33);
  // 离开文件区再回来，宽度还在。
  const away = update(dragged, { kind: "workbench_key", ordinal: 3 }) as Model;
  expect(away.destinationIndex).toBe(0);
  const back = update(away, { kind: "workbench_key", ordinal: 2 }) as Model;
  expect(back.destinationIndex).toBe(1);
  expect(back.layoutFraction).toBe(0.33);
});

test("a config reply lands the panel material only from a config reply", () => {
  // 提取必须只认 config 答复：别的答复没有 panel_material，若无门槛地盖，
  // 一次搜索就把作者的液态玻璃冲回实心。
  const configJson = new TextEncoder().encode(
    '{"kind":"config","value":{"appearance":{"panel_material":"liquid"}}}',
  );
  const landed = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, configJson),
  }) as Model;
  expect(landed.panelMaterial).toBe(2);
  const searchJson = new TextEncoder().encode('{"kind":"blocks","value":{"blocks":[]}}');
  const searched = update(landed, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, searchJson),
  }) as Model;
  expect(searched.panelMaterial).toBe(2);
});

test("choosing a panel material records the index and persists the kebab word", () => {
  const chosen = update(model, { kind: "material_select", index: 1 });
  if (!hasEffect(chosen)) throw new Error("material_select must persist the choice");
  expect(chosen[0].panelMaterial).toBe(1);
  if (chosen[1].op !== "request") throw new Error("material_select did not issue the host request");
  expect(
    decoder.decode(chosen[1].payload.slice(OFFSET_TEXT)).includes('"setPanelMaterial":"acrylic"'),
  ).toBe(true);
  // 越界与 NaN 回落实心，落盘的也是实心——与 theme_select 的越界同一句。
  for (const bad of [-1, 3, 1.5, Number.NaN]) {
    const fallback = update(model, { kind: "material_select", index: bad });
    if (!hasEffect(fallback)) throw new Error("material_select must persist the fallback");
    expect(fallback[0].panelMaterial).toBe(0);
    expect(
      decoder.decode(fallback[1].payload.slice(OFFSET_TEXT)).includes('"setPanelMaterial":"solid"'),
    ).toBe(true);
  }
});

test("a preview reply lives in its own slot and dies only when consumed", () => {
  // 审计 #8：预览曾住公共槽，一次「刷新名录」就把 digest 冲掉、送出静默
  // 退化为无核对。专槽让 digest 活到被消费（dispatched）或被下次预览替换。
  const previewJson = new TextEncoder().encode(
    '{"kind":"dispatchPreview","value":{"digest":"abc123def456","manifest":[]}}',
  );
  const previewed = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, previewJson),
  }) as Model;
  expect(decoder.decode(previewed.deskPreview).includes('"digest":"abc123def456"')).toBe(true);
  const blocksJson = new TextEncoder().encode('{"kind":"documentBlocks","value":{"blocks":[]}}');
  const refreshed = update(previewed, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, blocksJson),
  }) as Model;
  expect(decoder.decode(refreshed.deskPreview).includes("abc123def456")).toBe(true);
  // 送出成功清槽：这次预览已被消费。
  const dispatchedJson = new TextEncoder().encode('{"kind":"dispatched","value":{}}');
  const sent = update(refreshed, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, dispatchedJson),
  }) as Model;
  expect(sent.deskPreview.length).toBe(0);
});

test("the startup handshake chains one config read", () => {
  // 握手只发生一次（`initialModel` 的唯一一条 health），连带 readConfig：
  // 排版三值与主题名随答复落地，正文首帧与设置页不必等作者先按「读取设置」。
  const response = responseBytes(ACTION_HEALTH, 0);
  writeU16(response, 12, API_VERSION);
  writeU32(response, 16, CAPABILITY_MASK);
  const result = update(model, { kind: "dispatch_ok", bytes: response });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("health handshake did not chain the config read");
  expect(result[0].hostReady).toBe(true);
  const command = result[1];
  if (command.op !== "request") throw new Error("health handshake did not issue the config read");
  expect(readF64(command.payload, OFFSET_ACTION)).toBe(ACTION_PROJECT);
  const text = command.payload.slice(OFFSET_TEXT, command.payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe('{"kind":"readConfig"}');
});

test("a config reply lands the typography triple and recolumns the manuscript", () => {
  // 设置答复带排版三值（Config 的 serde 原名）；行长从 65 收到 50，
  // 断行还是旧行长的，连带一次重投影。
  const json = new TextEncoder().encode(
    '{"kind":"config","value":{"appearance":{"typography":{' +
      '"text_size_tenths_px":180,"line_height_percent":200,"measure_tenths_em":500}}}}',
  );
  const result = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, json),
  });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("a smaller measure did not chain a re-projection");
  expect(result[0].typographyTextSize).toBe(18);
  expect(result[0].typographyLineHeightPercent).toBe(200);
  expect(result[0].typographyMeasureEm).toBe(50);
  expect(result[0].documentColumnsEm).toBe(50);
  const command = result[1];
  if (command.op !== "request") throw new Error("a smaller measure did not issue a re-projection");
  expect(readF64(command.payload, OFFSET_ACTION)).toBe(ACTION_OBTAIN_PROJECTION);
  expect(readF64(command.payload, OFFSET_SCROLL_OFFSET_Y)).toBe(0);
});

test("a project reply without typography keeps the current triple", () => {
  // 信箱/搜索答复不带排版字段：三值保持，也不重投影。
  const json = new TextEncoder().encode('{"kind":"mailbox","value":{}}');
  const result = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, json),
  });
  if (hasEffect(result)) throw new Error("an unrelated reply unexpectedly chained a re-projection");
  expect(result.typographyTextSize).toBe(17);
  expect(result.typographyLineHeightPercent).toBe(190);
  expect(result.typographyMeasureEm).toBe(65);
  expect(result.documentColumnsEm).toBe(65);
});

test("a frame recolumns the manuscript from the real window width", () => {
  // 稿子占整宽分栏（fraction 1）：(640 - 48) / 17 ≈ 34.8 < 作者行长 65，
  // 实测按住行长 → 连带重投影。视口高 = 帧高扣 chrome。
  const narrow = update(model, { kind: "frame", width: 640, height: 800 });
  expect(hasEffect(narrow)).toBe(true);
  if (!hasEffect(narrow)) throw new Error("a narrower window did not chain a re-projection");
  expect(narrow[0].windowWidth).toBe(640);
  expect(narrow[0].documentColumnsEm).toBeCloseTo((640 - 48) / 17, 5);
  expect(narrow[0].documentViewportHeight).toBe(800 - 78);
  // 同一尺寸再来：行长没变，只落地，不重投影（变化检测在 frameMsg 已经
  // 挡过一次，update 再挡一次是双保险）。
  const same = update(narrow[0], { kind: "frame", width: 640, height: 800 });
  if (hasEffect(same)) throw new Error("an unchanged frame unexpectedly chained a re-projection");
});

test("frameMsg only reports size changes", () => {
  const frame = { width: 1280, height: 800, timestampMs: 0, intervalMs: 16 };
  expect(frameMsg(model, frame)).not.toBeNull();
  const sized: Model = { ...model, windowWidth: 1280, windowHeight: 800 };
  expect(frameMsg(sized, { ...frame, timestampMs: 16 })).toBeNull();
});

test("a kara reply lands the machine state and the quiet queue mask", () => {
  // KARA 答复的形状：machine.state.kind + machine.queued。effects 里的
  // queueForDebrief 也提事件名——掩码只认 queued 数组里的。
  const json = new TextEncoder().encode(
    '{"kind":"kara","value":{"machine":{"state":{"kind":"writing"},"autoEntry":"pending",' +
      '"queued":["save-succeeded","proposal-arrived"]},"effects":[' +
      '{"kind":"queueForDebrief","value":"agent-completed"}]}}',
  );
  const result = update(model, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, json),
  });
  if (hasEffect(result)) throw new Error("a kara reply unexpectedly chained a re-projection");
  expect(result.karaState).toBe(2); // writing
  expect(result.karaQueued).toBe(1 | 4); // 已保存 + 提案到达；agent-completed 只在 effects 里
});

test("a reply without a kara machine keeps the recorded state and queue", () => {
  const kara: Model = { ...model, karaState: 4, karaQueued: 8 };
  const json = new TextEncoder().encode('{"kind":"mailbox","value":{}}');
  const result = update(kara, {
    kind: "dispatch_ok",
    bytes: responseBytes(ACTION_PROJECT, 0, json),
  });
  if (hasEffect(result)) throw new Error("an unrelated reply unexpectedly chained a re-projection");
  expect(result.karaState).toBe(4);
  expect(result.karaQueued).toBe(8);
});

test("a cross-document hit opens with a pending jump and the open reply fires it", () => {
  // 第一程：挂起块序号随打开一起记（v0.2.4 的 selectDocument→revealBlock）。
  const reference = new TextEncoder().encode("root-1\n章二.md");
  const opening = update(model, { kind: "document_open_jump", reference, block: 41 });
  expect(hasEffect(opening)).toBe(true);
  if (!hasEffect(opening)) throw new Error("open-jump did not return an effect");
  expect(opening[0].pendingJumpBlock).toBe(41);
  expect(decoder.decode(opening[0].documentPath)).toBe("章二.md");
  if (opening[1].op !== "request") throw new Error("open-jump did not issue the open");
  expect(readF64(opening[1].payload, OFFSET_ACTION)).toBe(ACTION_OPEN_MANUSCRIPT);

  // 第二程：打开答复落地，补发跳块投影并清掉挂起。
  const response = responseBytes(ACTION_OPEN_MANUSCRIPT, 0);
  writeU32(response, 20, 9); // session
  writeU32(response, 24, 3); // revision
  writeU32(response, 28, 1000);
  writeU32(response, 32, 60);
  const jumped = update(opening[0], { kind: "dispatch_ok", bytes: response });
  expect(hasEffect(jumped)).toBe(true);
  if (!hasEffect(jumped)) throw new Error("the open reply did not chain the pending jump");
  expect(jumped[0].pendingJumpBlock).toBe(-1);
  expect(jumped[0].viewportFirstBlock).toBe(41);
  if (jumped[1].op !== "request") throw new Error("the open reply did not issue the jump");
  expect(readF64(jumped[1].payload, OFFSET_ACTION)).toBe(ACTION_OBTAIN_PROJECTION);
  expect(readF64(jumped[1].payload, OFFSET_SCROLL_OFFSET_Y)).toBe(0);
});

test("an open reply without a pending jump does not chain one", () => {
  const response = responseBytes(ACTION_OPEN_MANUSCRIPT, 0);
  writeU32(response, 20, 9);
  writeU32(response, 24, 3);
  writeU32(response, 28, 1000);
  writeU32(response, 32, 60);
  const result = update(model, { kind: "dispatch_ok", bytes: response });
  if (hasEffect(result)) throw new Error("a plain open reply unexpectedly chained a projection");
  expect(result.pendingJumpBlock).toBe(-1);
});

test("a failed open clears the pending jump without firing it", () => {
  const reference = new TextEncoder().encode("root-1\n章二.md");
  const opening = update(model, { kind: "document_open_jump", reference, block: 41 });
  if (!hasEffect(opening)) throw new Error("open-jump did not return an effect");
  const response = responseBytes(ACTION_OPEN_MANUSCRIPT, 0);
  writeU32(response, 20, 0); // session 0：没开成
  const result = update(opening[0], { kind: "dispatch_ok", bytes: response });
  if (hasEffect(result)) throw new Error("a failed open unexpectedly chained a jump");
  expect(result.pendingJumpBlock).toBe(-1);
});

test("the bento forwards the prebuilt accept and reject bytes at keypress", () => {
  // 开盒：id、预编请求与起笔一起落地（全部 Zig 读出与编好）。
  const opened = update(model, {
    kind: "verdict_begin",
    proposalId: new TextEncoder().encode("proposal-1"),
    accept: new TextEncoder().encode('{"kind":"judgeVerdict","value":{"kind":"accept"}}'),
    reject: new TextEncoder().encode('{"kind":"judgeVerdict","value":{"kind":"reject"}}'),
    seed: new TextEncoder().encode("改后的样子。"),
  });
  if (hasEffect(opened)) throw new Error("opening the bento unexpectedly returned an effect");
  expect(decoder.decode(opened.verdictProposal)).toBe("proposal-1");

  // Alt+A → 接受：转发的正是预编字节，饭盒关上。
  const accepted = update(opened, { kind: "verdict_accept" });
  expect(hasEffect(accepted)).toBe(true);
  if (!hasEffect(accepted)) throw new Error("verdict_accept did not forward the prebuilt request");
  expect(accepted[0].verdictProposal.length).toBe(0);
  if (accepted[1].op !== "request") throw new Error("verdict_accept did not issue the request");
  const text = accepted[1].payload.slice(OFFSET_TEXT, accepted[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe('{"kind":"judgeVerdict","value":{"kind":"accept"}}');

  // 关着的饭盒：Alt+B 原地不动（键位不猜默认动作）。
  const closed = update(accepted[0], { kind: "verdict_reject" });
  if (hasEffect(closed)) throw new Error("a closed bento unexpectedly answered a verdict key");
  expect(closed).toBe(accepted[0]);

  // Alt+E → 改写：提案与起笔进改写态。
  const revising = update(opened, { kind: "verdict_revise" });
  if (hasEffect(revising)) throw new Error("verdict_revise unexpectedly returned an effect");
  expect(decoder.decode(revising.revisingProposal)).toBe("proposal-1");
  expect(decoder.decode(revising.revisionText)).toBe("改后的样子。");
});

test("keyMsg maps the bento keys and ignores everything else", () => {
  expect(keyMsg({ key: "a", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "verdict_accept",
  });
  expect(keyMsg({ key: "b", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "verdict_reject",
  });
  expect(keyMsg({ key: "e", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "verdict_revise",
  });
  expect(keyMsg({ key: "a", alt: false, shift: false, control: false, super: false })).toBeNull();
  expect(keyMsg({ key: "x", alt: true, shift: false, control: false, super: false })).toBeNull();
});

test("keyMsg maps the review-desk keys (Alt+J/K/R/P/Enter)", () => {
  // v0.2.4 裁决台键盘流：移动就是名录步进（roster.ts 共用），理由、竞争稿
  // 与落定各有自己的臂。
  expect(keyMsg({ key: "j", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "roster_step",
    delta: 1,
  });
  expect(keyMsg({ key: "k", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "roster_step",
    delta: -1,
  });
  expect(keyMsg({ key: "r", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "review_reason_open",
  });
  expect(keyMsg({ key: "p", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "review_peer",
  });
  expect(keyMsg({ key: "enter", alt: true, shift: false, control: false, super: false })).toEqual({
    kind: "verdict_settle",
  });
});

// —— 2.1b 裁决台键盘流 ——

const PROPOSALS_REPLY =
  '{"kind":"proposals","value":{"proposals":[' +
  '{"id":"p1","scope":"[\\"b1\\"]","beforeText":"原句一。","afterText":"改句一。"},' +
  '{"id":"p2","scope":"[\\"b2\\"]","beforeText":"原句二。","afterText":null},' +
  '{"id":"p3","scope":"[\\"b1\\"]","beforeText":"原句一。","afterText":"竞句一。"}' +
  '],"staged":["p1"]}}';

/** 台面就位：栈顶是裁决台、名录在 projectResult、游标指着第一行。 */
function deskModel(): Model {
  return {
    ...model,
    panelStack: 2, // pushStack(0, DESTINATION_REVIEW)：栈底 2 = 栈顶裁决台
    rootId: new TextEncoder().encode("r1"),
    documentPath: new TextEncoder().encode("章.md"),
    rosterCount: 3,
    rosterCursor: 0,
    rosterHasRow: true,
    stagedCount: 1,
    projectResult: new TextEncoder().encode(PROPOSALS_REPLY),
  };
}

test("a proposals reply lands the roster facts and clears a stale panel", () => {
  const armed: Model = {
    ...model,
    reviewAdvanceArmed: true,
    rosterCursor: 9, // 钳进新长度：9 超出三行，回到末行
    staleFrozen: new TextEncoder().encode("旧冻结原文"),
    staleRecovery: new TextEncoder().encode("send-again"),
  };
  const reply = responseBytes(ACTION_PROJECT, 0, new TextEncoder().encode(PROPOSALS_REPLY));
  const landed = update(armed, { kind: "dispatch_ok", bytes: reply });
  expect(hasEffect(landed)).toBe(true); // 判后前进挂上了延迟
  if (!hasEffect(landed)) throw new Error("the proposals reply did not arm the advance");
  expect(landed[0].rosterCount).toBe(3);
  expect(landed[0].rosterCursor).toBe(2);
  expect(landed[0].rosterHasRow).toBe(true);
  expect(landed[0].stagedCount).toBe(1);
  expect(landed[0].reviewPeer).toBe(0);
  expect(landed[0].staleRecovery.length).toBe(0);
  expect(landed[0].reviewAdvanceArmed).toBe(false);
  if (landed[1].op !== "delay") throw new Error("the reply did not issue the advance delay");
  expect(landed[1].afterMs).toBe(120);
  expect(landed[1].msgKind).toBe("review_advance");
});

test("review_advance steps one row and clamps at the end", () => {
  const desk = deskModel();
  const moved = update(desk, { kind: "review_advance", at: 1 }) as Model;
  expect(moved.rosterCursor).toBe(1);
  const last: Model = { ...desk, rosterCursor: 2 };
  expect((update(last, { kind: "review_advance", at: 2 }) as Model).rosterCursor).toBe(2);
});

test("Alt+A on the desk judges the cursor row and clears the reason", () => {
  const desk: Model = {
    ...deskModel(),
    reviewReason: new TextEncoder().encode('带着"引号"的理由'),
    reasonRecorded: true,
  };
  const judged = update(desk, { kind: "verdict_accept" });
  expect(hasEffect(judged)).toBe(true);
  if (!hasEffect(judged)) throw new Error("desk accept did not issue a request");
  const text = judged[1].payload.slice(OFFSET_TEXT, judged[1].payload.length - TRAILING_BYTES);
  // 字节与 Rust 的 serde 形状逐字节一致（wire_shapes 的 stageVerdict 同款），
  // 理由经转义进槽。
  expect(decoder.decode(text)).toBe(
    '{"kind":"stageVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p1","kind":"accept","finalText":null,"reason":"带着\\"引号\\"的理由"}}',
  );
  expect(judged[0].reasonRecorded).toBe(false);
  expect(judged[0].reviewReason.length).toBe(0);
  expect(judged[0].reviewAdvanceArmed).toBe(true);
});

test("Alt+B on the desk rejects the cursor row", () => {
  const desk: Model = { ...deskModel(), rosterCursor: 1 };
  const judged = update(desk, { kind: "verdict_reject" });
  if (!hasEffect(judged)) throw new Error("desk reject did not issue a request");
  const text = judged[1].payload.slice(OFFSET_TEXT, judged[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe(
    '{"kind":"stageVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p2","kind":"reject","finalText":null,"reason":null}}',
  );
});

test("desk verdict keys stay still off the desk or without a live listing", () => {
  // 不在台上（栈顶是稿子）：原地不动。
  const offDesk = update(model, { kind: "verdict_accept" });
  if (hasEffect(offDesk)) throw new Error("a verdict key fired off the desk");
  // 在台上但最新答复不是名录（旧答复）：也原地不动。
  const stale: Model = {
    ...deskModel(),
    projectResult: new TextEncoder().encode('{"kind":"decided","value":{"state":"durable"}}'),
  };
  const notLive = update(stale, { kind: "verdict_accept" });
  if (hasEffect(notLive)) throw new Error("a verdict key fired on a stale listing");
});

test("Alt+E on the desk opens the revision seeded from the cursor row", () => {
  const desk = deskModel();
  const revising = update(desk, { kind: "verdict_revise" }) as Model;
  expect(decoder.decode(revising.revisingProposal)).toBe("p1");
  expect(decoder.decode(revising.revisionText)).toBe("改句一。");
  // 只评论的提案（afterText null）：键原地不动。
  const commentOnly: Model = { ...desk, rosterCursor: 1 };
  const still = update(commentOnly, { kind: "verdict_revise" }) as Model;
  expect(still.revisingProposal.length).toBe(0);
});

test("the reason round trip: open prefills, Enter records even empty, Escape keeps", () => {
  const desk = deskModel();
  const opened = update(desk, { kind: "review_reason_open" }) as Model;
  expect(opened.reasonOpen).toBe(true);
  const typed = update(opened, {
    kind: "review_reason_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("语气更稳") },
  }) as Model;
  const committed = update(typed, { kind: "review_reason_commit" }) as Model;
  expect(committed.reasonOpen).toBe(false);
  expect(committed.reasonRecorded).toBe(true);
  expect(decoder.decode(committed.reviewReason)).toBe("语气更稳");
  // Escape：草稿丢掉，已记下的不动。
  const reopened = update(committed, { kind: "review_reason_open" }) as Model;
  expect(decoder.decode(reopened.reasonDraft)).toBe("语气更稳");
  const cancelled = update(reopened, { kind: "review_reason_cancel" }) as Model;
  expect(cancelled.reasonOpen).toBe(false);
  expect(decoder.decode(cancelled.reviewReason)).toBe("语气更稳");
});

test("verdict_settle commits the batch on the desk and chains a re-read", () => {
  const desk = deskModel();
  const settled = update(desk, { kind: "verdict_settle" });
  if (!hasEffect(settled)) throw new Error("the settle did not issue the commit");
  const text = settled[1].payload.slice(OFFSET_TEXT, settled[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe(
    '{"kind":"commitVerdicts","value":{"rootId":"r1","path":"章.md"}}',
  );
  // decided 答复 → 连锁重读名录（判过的提案已被领域层收走）。
  const decided = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode('{"kind":"decided","value":{"state":"durable"}}'),
  );
  const refreshed = update(settled[0], { kind: "dispatch_ok", bytes: decided });
  if (!hasEffect(refreshed)) throw new Error("the decided reply did not chain a re-read");
  const reread = refreshed[1].payload.slice(
    OFFSET_TEXT,
    refreshed[1].payload.length - TRAILING_BYTES,
  );
  expect(decoder.decode(reread)).toBe(
    '{"kind":"readProposals","value":{"rootId":"r1","path":"章.md"}}',
  );
});

test("verdict_settle on an empty batch says so instead of firing", () => {
  const desk: Model = { ...deskModel(), stagedCount: 0 };
  const still = update(desk, { kind: "verdict_settle" });
  if (hasEffect(still)) throw new Error("an empty batch unexpectedly fired a commit");
  expect(decoder.decode(still.status)).toBe("No staged verdicts to commit.");
});

test("verdict_settle while revising on the desk stages accept-modified", () => {
  const desk: Model = {
    ...deskModel(),
    revisingProposal: new TextEncoder().encode("p1"),
    revisionText: new TextEncoder().encode("作者改定的一句。"),
  };
  const settled = update(desk, { kind: "verdict_settle" });
  if (!hasEffect(settled)) throw new Error("the revision settle did not fire");
  const text = settled[1].payload.slice(OFFSET_TEXT, settled[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe(
    '{"kind":"stageVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p1","kind":"accept-modified","finalText":"作者改定的一句。","reason":null}}',
  );
  expect(settled[0].revisingProposal.length).toBe(0);
  expect(settled[0].reviewAdvanceArmed).toBe(true);
});

test("verdict_settle while revising in the bento judges accept-modified", () => {
  const bento: Model = {
    ...model,
    rootId: new TextEncoder().encode("r1"),
    documentPath: new TextEncoder().encode("章.md"),
    verdictProposal: new TextEncoder().encode("p9"),
    revisingProposal: new TextEncoder().encode("p9"),
    revisionText: new TextEncoder().encode("盒里改定的一句。"),
  };
  const settled = update(bento, { kind: "verdict_settle" });
  if (!hasEffect(settled)) throw new Error("the bento settle did not fire");
  const text = settled[1].payload.slice(OFFSET_TEXT, settled[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe(
    '{"kind":"judgeVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p9","kind":"accept-modified","finalText":"盒里改定的一句。","reason":null}}',
  );
  // 饭盒落定后连盒一起关，且不挂判后前进（不在台上）。
  expect(settled[0].verdictProposal.length).toBe(0);
  expect(settled[0].reviewAdvanceArmed).toBe(false);
});

test("a stale refusal lands the frozen text and the recovery steps", () => {
  const refusal = new TextEncoder().encode(
    '{"code":"stale-proposal","action":"commit a decision batch","subject":"章.md","detail":"Agent 当时读到的\\n原文。","recovery":["compare-with-frozen-text","send-again"]}',
  );
  const armed: Model = { ...deskModel(), reviewAdvanceArmed: true };
  const landed = update(armed, {
    kind: "dispatch_err",
    bytes: responseBytes(ACTION_PROJECT, 4, refusal), // 4 = ERROR_DOMAIN_REFUSAL
  }) as Model;
  expect(decoder.decode(landed.staleFrozen)).toBe("Agent 当时读到的\n原文。");
  expect(decoder.decode(landed.staleRecovery)).toBe("compare-with-frozen-text\nsend-again");
  expect(landed.reviewAdvanceArmed).toBe(false);
});

test("review_peer flips only on the desk with a row", () => {
  const desk = deskModel();
  expect((update(desk, { kind: "review_peer" }) as Model).reviewPeer).toBe(1);
  expect((update(model, { kind: "review_peer" }) as Model).reviewPeer).toBe(0);
});

test("panel_back closes the reason editor before popping the desk", () => {
  const desk: Model = {
    ...deskModel(),
    reasonOpen: true,
    reasonDraft: new TextEncoder().encode("x"),
  };
  const closed = update(desk, { kind: "panel_back" }) as Model;
  expect(closed.reasonOpen).toBe(false);
  expect(closed.reasonDraft.length).toBe(0);
  expect(closed.panelStack).toBe(2); // 没有退栈——一次只关一层
});

// —— 2.2 派发深度：块清单与攒进发送 ——

const BLOCKS_REPLY =
  '{"kind":"documentBlocks","value":{"blocks":[' +
  '{"id":"b0","ordinal":0,"kind":"paragraph","peek":"一。","chars":2},' +
  '{"id":"b1","ordinal":1,"kind":"paragraph","peek":"二。","chars":2},' +
  '{"id":"b2","ordinal":2,"kind":"paragraph","peek":"三。","chars":2}' +
  '],"next":3}}';

test("a documentBlocks reply lands in its own slot with the page cursor", () => {
  // 槽的意义：别的答复（这里是设置）落地不该把块清单冲掉。
  const reply = responseBytes(ACTION_PROJECT, 0, new TextEncoder().encode(BLOCKS_REPLY));
  const landed = update(model, { kind: "dispatch_ok", bytes: reply }) as Model;
  expect(landed.deskBlocks.length).toBeGreaterThan(0);
  expect(landed.deskBlocksNext).toBe(3);
  const other = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode('{"kind":"config","value":{"text_size_tenths_px":170}}'),
  );
  const kept = update(landed, { kind: "dispatch_ok", bytes: other }) as Model;
  expect(kept.deskBlocks.length).toBe(landed.deskBlocks.length);
  expect(kept.deskBlocksNext).toBe(3);
});

test("the last blocks page reports no next cursor", () => {
  const tail = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode('{"kind":"documentBlocks","value":{"blocks":[],"next":null}}'),
  );
  const landed = update(model, { kind: "dispatch_ok", bytes: tail }) as Model;
  expect(landed.deskBlocksNext).toBe(-1);
});

test("block toggling flips one bit, all fills by the block total, clear empties", () => {
  const stocked: Model = { ...model, documentBlocks: 5 };
  const checked = update(stocked, { kind: "dispatch_block_toggle", ordinal: 1 }) as Model;
  expect(Array.from(checked.dispatchChecked)).toEqual([2]);
  const also = update(checked, { kind: "dispatch_block_toggle", ordinal: 4 }) as Model;
  expect(Array.from(also.dispatchChecked)).toEqual([18]);
  // 再点一次取消同一块。
  const off = update(also, { kind: "dispatch_block_toggle", ordinal: 1 }) as Model;
  expect(Array.from(off.dispatchChecked)).toEqual([16]);
  // 整章：5 块 = 0b00011111（末字节只铺满到总数）。
  const all = update(stocked, { kind: "dispatch_blocks_all" }) as Model;
  expect(Array.from(all.dispatchChecked)).toEqual([31]);
  expect((update(all, { kind: "dispatch_blocks_clear" }) as Model).dispatchChecked.length).toBe(0);
});

test("opening another document clears the block listing and the checks", () => {
  const stocked: Model = {
    ...model,
    deskBlocks: new TextEncoder().encode(BLOCKS_REPLY),
    deskBlocksNext: 3,
    dispatchChecked: new Uint8Array([3]),
  };
  const opening = update(stocked, {
    kind: "document_open",
    reference: new TextEncoder().encode("r1\n章二.md"),
  });
  if (!hasEffect(opening)) throw new Error("document_open did not return an effect");
  expect(opening[0].deskBlocks.length).toBe(0);
  expect(opening[0].deskBlocksNext).toBe(-1);
  expect(opening[0].dispatchChecked.length).toBe(0);
});

test("the stash collects passages, drops one, and clears", () => {
  const one = update(model, {
    kind: "dispatch_stash",
    text: new TextEncoder().encode("第一段。"),
  }) as Model;
  expect(one.noticeShown).toBe(true);
  const two = update(one, {
    kind: "dispatch_stash",
    text: new TextEncoder().encode("第二段。"),
  }) as Model;
  // NUL 分隔：攒两段 = 段一 + NUL + 段二。
  const joined = "第一段。" + "第二段。";
  expect(two.dispatchStash.length).toBe(new TextEncoder().encode(joined).length + 1);
  expect(two.dispatchStash[new TextEncoder().encode("第一段。").length]).toBe(0);
  const dropped = update(two, { kind: "dispatch_stash_drop", index: 0 }) as Model;
  expect(decoder.decode(dropped.dispatchStash)).toBe("第二段。");
  // 越界序号原样不动。
  const untouched = update(dropped, { kind: "dispatch_stash_drop", index: 5 }) as Model;
  expect(decoder.decode(untouched.dispatchStash)).toBe("第二段。");
  expect((update(two, { kind: "dispatch_stash_clear" }) as Model).dispatchStash.length).toBe(0);
});

test("materials toggle on and off by path", () => {
  const on = update(model, {
    kind: "dispatch_material_toggle",
    path: new TextEncoder().encode("设定/甲.md"),
  }) as Model;
  expect(decoder.decode(on.dispatchMaterials)).toBe("设定/甲.md");
  const two = update(on, {
    kind: "dispatch_material_toggle",
    path: new TextEncoder().encode("设定/乙.md"),
  }) as Model;
  expect(decoder.decode(two.dispatchMaterials)).toBe("设定/甲.md\n设定/乙.md");
  // 再点甲：删掉甲，乙留着。
  const off = update(two, {
    kind: "dispatch_material_toggle",
    path: new TextEncoder().encode("设定/甲.md"),
  }) as Model;
  expect(decoder.decode(off.dispatchMaterials)).toBe("设定/乙.md");
});

test("carry mode is a direct three-way choice with a safe fallback", () => {
  expect((update(model, { kind: "dispatch_carry", index: 1 }) as Model).dispatchCarry).toBe(1);
  expect((update(model, { kind: "dispatch_carry", index: 2 }) as Model).dispatchCarry).toBe(2);
  // 越界回落增量（0）：一个指不到的档不该送出。
  expect((update(model, { kind: "dispatch_carry", index: 9 }) as Model).dispatchCarry).toBe(0);
});

test("choosing an agent records its id", () => {
  const chosen = update(model, {
    kind: "dispatch_agent",
    id: new TextEncoder().encode("agent-7"),
  }) as Model;
  expect(decoder.decode(chosen.dispatchAgent)).toBe("agent-7");
});

// —— 2.4 即打即搜 ——

test("typing arms the 120ms debounce and firing sends the block search", () => {
  const ready: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const typed = update(ready, {
    kind: "search_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("剑") },
  });
  if (!hasEffect(typed)) throw new Error("typing did not arm the debounce");
  if (typed[1].op !== "delay") throw new Error("the debounce is not a delay");
  expect(typed[1].afterMs).toBe(120);
  expect(typed[1].msgKind).toBe("search_fire");
  // 到点开火：core 拼的块搜索请求与 Zig 写器同形。
  const fired = update(typed[0], { kind: "search_fire", at: 1 });
  if (!hasEffect(fired)) throw new Error("search_fire did not send the search");
  const text = fired[1].payload.slice(OFFSET_TEXT, fired[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe(
    '{"kind":"blockSearch","value":{"rootId":"r1","query":"剑","precision":"exact"}}',
  );
});

test("an empty query goes idle instead of firing", () => {
  const ready: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const typed = update(ready, {
    kind: "search_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("x") },
  });
  if (!hasEffect(typed)) throw new Error("typing did not arm");
  const cleared = update(typed[0], {
    kind: "search_typed",
    event: { kind: "clear" },
  });
  if (!hasEffect(cleared)) throw new Error("clearing did not answer a Cmd");
  expect(cleared[1].op).toBe("cancel");
  // 空查询到点也不发。
  const fired = update(cleared[0], { kind: "search_fire", at: 2 });
  if (hasEffect(fired)) throw new Error("an empty query unexpectedly fired");
});

// —— 2.3a KARA 表面：焦点通道、补发事件、回来卡与打断 ——

test("losing focus in writing arms the 8s away timer; refocus cancels it", () => {
  const writing: Model = { ...model, karaState: 2 };
  const blurred = update(writing, { kind: "app_focus", active: false });
  if (!hasEffect(blurred)) throw new Error("blur in writing did not arm the away timer");
  if (blurred[1].op !== "delay") throw new Error("the away arm is not a delay");
  expect(blurred[1].afterMs).toBe(8000);
  expect(blurred[1].msgKind).toBe("kara_gone_away");
  // 8 秒内回来：撤钟（cancel 是单独的 Cmd）。
  const back = update(writing, { kind: "app_focus", active: true });
  if (!hasEffect(back)) throw new Error("refocus did not answer a Cmd");
  expect(back[1].op).toBe("cancel");
  // off 状态下失焦不挂钟。
  const idle = update(model, { kind: "app_focus", active: false });
  if (hasEffect(idle)) throw new Error("blur outside KARA unexpectedly armed a timer");
});

test("refocus while away sends returned", () => {
  const away: Model = { ...model, karaState: 4 };
  const back = update(away, { kind: "app_focus", active: true });
  if (!hasEffect(back)) throw new Error("refocus in Away did not send returned");
  const text = back[1].payload.slice(OFFSET_TEXT, back[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe('{"kind":"karaStep","value":{"kind":"returned"}}');
});

test("the away timer only fires in writing or reviewing", () => {
  const writing: Model = { ...model, karaState: 3 };
  const fired = update(writing, { kind: "kara_gone_away", at: 1 });
  if (!hasEffect(fired)) throw new Error("gone_away did not fire in reviewing");
  const still = update(model, { kind: "kara_gone_away", at: 1 });
  if (hasEffect(still)) throw new Error("gone_away fired while off");
});

test("entered and leaveFinished fire only inside their own states", () => {
  const entering: Model = { ...model, karaState: 1 };
  const entered = update(entering, { kind: "kara_entered", at: 1 });
  if (!hasEffect(entered)) throw new Error("entered did not fire in Entering");
  const notEntering = update(model, { kind: "kara_entered", at: 1 });
  if (hasEffect(notEntering)) throw new Error("entered fired outside Entering");
  const leaving: Model = { ...model, karaState: 5 };
  const finished = update(leaving, { kind: "kara_leave_finished", at: 1 });
  if (!hasEffect(finished)) throw new Error("leaveFinished did not fire in Leaving");
});

test("a kara reply with showReturnCard lands the card and arms its dismiss", () => {
  const reply = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"kara","value":{"machine":{"state":{"kind":"writing","value":{"session":{"activity":"writing","returnPoint":{"blockId":"","offset":41,"sentenceTail":"光标的落点"}}}},"autoEntry":"consumed","queued":[]},"effects":[{"kind":"showReturnCard","value":{"point":{"blockId":"","offset":41,"sentenceTail":"光标的落点"}}}]}}',
    ),
  );
  const landed = update(model, { kind: "dispatch_ok", bytes: reply });
  if (!hasEffect(landed)) throw new Error("the return card did not arm a dismiss");
  expect(landed[0].karaCard).toBe(true);
  expect(decoder.decode(landed[0].karaReturnTail)).toBe("光标的落点");
  if (landed[1].op !== "delay") throw new Error("the card dismiss is not a delay");
  expect(landed[1].afterMs).toBe(600);
  // 600ms 后自消。
  const done = update(landed[0], { kind: "kara_card_done", at: 2 }) as Model;
  expect(done.karaCard).toBe(false);
  expect(done.karaReturnTail.length).toBe(0);
});

test("an interrupt lands its code and self-dismisses after 4s", () => {
  const reply = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"kara","value":{"machine":{"state":{"kind":"writing","value":{"session":{"activity":"writing","returnPoint":{"blockId":"","offset":0,"sentenceTail":""}}}},"autoEntry":"consumed","queued":[]},"effects":[{"kind":"interruptNow","value":"save-failed"}]}}',
    ),
  );
  const landed = update(model, { kind: "dispatch_ok", bytes: reply });
  if (!hasEffect(landed)) throw new Error("the interrupt did not arm a dismiss");
  expect(decoder.decode(landed[0].karaInterrupt)).toBe("save-failed");
  if (landed[1].op !== "delay") throw new Error("the interrupt dismiss is not a delay");
  expect(landed[1].afterMs).toBe(4000);
  const done = update(landed[0], { kind: "kara_interrupt_done", at: 9 }) as Model;
  expect(done.karaInterrupt.length).toBe(0);
});

test("a kara reply entering Entering arms the 700ms entered sender", () => {
  const reply = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"kara","value":{"machine":{"state":{"kind":"entering","value":{"activity":"writing","returnPoint":{"blockId":"","offset":0,"sentenceTail":""}}},"autoEntry":"consumed","queued":[]},"effects":[]}}',
    ),
  );
  const landed = update(model, { kind: "dispatch_ok", bytes: reply });
  if (!hasEffect(landed)) throw new Error("Entering did not arm the entered sender");
  if (landed[1].op !== "delay") throw new Error("the entered arm is not a delay");
  expect(landed[1].afterMs).toBe(700);
  expect(landed[1].msgKind).toBe("kara_entered");
});

// —— 2.2b-2 Run 名录轮询与材料草稿行内编辑 ——

test("a host snapshot with an in-flight run arms the 2500ms tick", () => {
  const hosted: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const snapshot = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"host","value":{"tasks":[],"runs":[{"id":"run-1","progress":{"kind":"dispatched","value":{"receipt":"r"}}}],"authorizations":[],"runsAwaitingLaunch":[]}}',
    ),
  );
  const landed = update(hosted, { kind: "dispatch_ok", bytes: snapshot });
  if (!hasEffect(landed)) throw new Error("an in-flight snapshot did not arm the tick");
  expect(landed[0].deskHost.length).toBeGreaterThan(0);
  if (landed[1].op !== "delay") throw new Error("the tick is not a delay");
  expect(landed[1].afterMs).toBe(2500);
  expect(landed[1].msgKind).toBe("runs_tick");
});

test("a settled host snapshot stops the polling chain", () => {
  const hosted: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const snapshot = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"host","value":{"tasks":[],"runs":[{"id":"run-1","progress":{"kind":"completed","value":{"artifactDigest":"d"}}}],"authorizations":[],"runsAwaitingLaunch":[]}}',
    ),
  );
  const landed = update(hosted, { kind: "dispatch_ok", bytes: snapshot });
  if (hasEffect(landed)) throw new Error("a settled snapshot unexpectedly armed a tick");
  expect(landed.deskHost.length).toBeGreaterThan(0);
});

test("runs_tick re-reads the host snapshot", () => {
  const hosted: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const ticked = update(hosted, { kind: "runs_tick", at: 1 });
  if (!hasEffect(ticked)) throw new Error("the tick did not issue a read");
  const text = ticked[1].payload.slice(OFFSET_TEXT, ticked[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe('{"kind":"readHost","value":{"rootId":"r1"}}');
  // 没有项目时不发。
  const empty = update(model, { kind: "runs_tick", at: 1 });
  if (hasEffect(empty)) throw new Error("a tick without a project unexpectedly fired");
});

test("a dispatched reply chains a host snapshot read", () => {
  const hosted: Model = { ...model, rootId: new TextEncoder().encode("r1") };
  const reply = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode(
      '{"kind":"dispatched","value":{"runs":["run-1"],"digest":"d","prefixBytes":9}}',
    ),
  );
  const landed = update(hosted, { kind: "dispatch_ok", bytes: reply });
  if (!hasEffect(landed)) throw new Error("a dispatched reply did not chain the snapshot read");
  const text = landed[1].payload.slice(OFFSET_TEXT, landed[1].payload.length - TRAILING_BYTES);
  expect(decoder.decode(text)).toBe('{"kind":"readHost","value":{"rootId":"r1"}}');
});

test("a materialDrafts reply closes the inline editor", () => {
  const editing: Model = {
    ...model,
    materialDraftId: new TextEncoder().encode("d1"),
    materialDraftText: new TextEncoder().encode("改到一半"),
  };
  const reply = responseBytes(
    ACTION_PROJECT,
    0,
    new TextEncoder().encode('{"kind":"materialDrafts","value":[]}'),
  );
  const landed = update(editing, { kind: "dispatch_ok", bytes: reply }) as Model;
  expect(landed.materialDraftId.length).toBe(0);
  expect(landed.materialDraftText.length).toBe(0);
});

test("the material draft editor opens with the body, types, and cancels", () => {
  const begun = update(model, {
    kind: "material_draft_begin",
    id: new TextEncoder().encode("d1"),
    seed: new TextEncoder().encode("草稿正文。"),
  }) as Model;
  expect(decoder.decode(begun.materialDraftText)).toBe("草稿正文。");
  const typed = update(begun, {
    kind: "material_draft_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("补一句。") },
  }) as Model;
  expect(decoder.decode(typed.materialDraftText)).toBe("草稿正文。补一句。");
  // 没在编辑时打字不动（守卫与改写框同款）。
  const stray = update(model, {
    kind: "material_draft_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("x") },
  }) as Model;
  expect(stray.materialDraftText.length).toBe(0);
  const cancelled = update(typed, { kind: "material_draft_cancel" }) as Model;
  expect(cancelled.materialDraftId.length).toBe(0);
  expect(cancelled.materialDraftText.length).toBe(0);
});

// ── 2.13 悬停开栏（探头态）───────────────────────────────────────────
// 交互设计：指针贴到窗口左缘 4px 的探头条就开栏到文件去处；开过之后只要
// 作者没动过（railPeek 仍在），指针移出整个栏宽就收回稿子；动过就留下，
// 变成手动栏。迟滞由栏宽天然提供——开 4px、关约 248px，栏不在边缘抖动。

// 共享桩的 windowWidth 是 0：行长公式在轨道宽 ≤ 0 时回退行长上限（65），
// 重投影判据因此恒「没变」。探头测试需要一个真实窗宽——栏开合改变分栏
// 比例，行长跟着变，重投影效果才真的挂上。
const peekSized: Model = { ...model, windowWidth: 1280 };

test("rail_peek_open from the manuscript opens the file rail as a peek", () => {
  // 稿子全宽（destinationIndex 0）下悬停：落到文件去处并立起探头标记。
  // 栏宽变了行长跟着变，这一臂带重投影效果（元组）。
  const result = update(peekSized, { kind: "rail_peek_open" });
  expect(hasEffect(result)).toBe(true);
  if (!hasEffect(result)) throw new Error("rail_peek_open did not re-project");
  expect(result[0].destinationIndex).toBe(1);
  expect(result[0].railPeek).toBe(1);
});

test("rail_peek_open is a no-op away from the manuscript", () => {
  // 别的好去处下 rail 本来就在——探头只在稿子全宽时有意义。
  const reviewing = update(model, { kind: "workbench_go", index: 2 }) as Model;
  expect(reviewing.destinationIndex).toBe(2);
  const stayed = update(reviewing, { kind: "rail_peek_open" }) as Model;
  expect(stayed.destinationIndex).toBe(2);
  expect(stayed.railPeek).toBe(0);
});

test("machine messages do not release the peek state", () => {
  // 帧、轮询与答复是机器自己的动静：它们不解除探头态——否则轮询一跳就
  // 把栏变手动栏，「移出收回」永远不触发。
  const opened = update(peekSized, { kind: "rail_peek_open" });
  if (!hasEffect(opened)) throw new Error("rail_peek_open did not re-project");
  // 帧臂可能因窗口尺寸落地而带效果（元组）——每步都剥壳取 Model 再喂回去。
  const step = (m: Model, msg: Parameters<typeof updateCore>[1]): Model => {
    const out = update(m, msg);
    return (Array.isArray(out) ? out[0] : out) as Model;
  };
  let peeked = step(opened[0], { kind: "frame", width: 800, height: 600 });
  expect(peeked.railPeek).toBe(1);
  peeked = step(peeked, { kind: "runs_tick", at: 0 });
  expect(peeked.railPeek).toBe(1);
  const reply = responseBytes(ACTION_OBTAIN_PROJECTION, 0);
  writeU32(reply, 20, 7); // session
  writeU32(reply, 24, 4); // revision
  peeked = step(peeked, { kind: "dispatch_ok", bytes: reply });
  expect(peeked.railPeek).toBe(1);
});

test("any interaction releases the peek state but keeps the rail", () => {
  // 作者用过这栏（哪怕只是敲了搜索框）：栏留下，解除的只是「自动收回」
  // 的资格——此后 rail_peek_close 不再能把它收走。
  const opened = update(peekSized, { kind: "rail_peek_open" });
  if (!hasEffect(opened)) throw new Error("rail_peek_open did not re-project");
  // search_typed 会挂防抖效果（元组）——剥壳取 Model 再断言。
  const touchedOut = update(opened[0], {
    kind: "search_typed",
    event: { kind: "insert_text", text: new TextEncoder().encode("a") },
  });
  const touched = (Array.isArray(touchedOut) ? touchedOut[0] : touchedOut) as Model;
  expect(touched.railPeek).toBe(0);
  expect(touched.destinationIndex).toBe(1);
  const closed = update(touched, { kind: "rail_peek_close" }) as Model;
  expect(closed.destinationIndex).toBe(1); // no-op：栏留下
});

test("rail_peek_close retracts an untouched peeked rail to the manuscript", () => {
  // 指针移出整个栏宽而栏没被用过：收回稿子全宽，探头标记一起清。
  const opened = update(peekSized, { kind: "rail_peek_open" });
  if (!hasEffect(opened)) throw new Error("rail_peek_open did not re-project");
  const closed = update(opened[0], { kind: "rail_peek_close" });
  if (!hasEffect(closed)) throw new Error("rail_peek_close did not re-project");
  expect(closed[0].destinationIndex).toBe(0);
  expect(closed[0].railPeek).toBe(0);
});
