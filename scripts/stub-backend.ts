// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * 让 agent 在浏览器里看见真前端。
 *
 * 产品跑在 Tauri 里，前端启动就要 IPC。没有后端时 `App` 在第一次 `readConfig`
 * 就抛错，界面是一片空白——v0.2.1 那批灾难级前端正是这样盲着做出来的。
 *
 * 这里补的是**后端**，不是界面：`__TAURI_INTERNALS__` 被换成一张回答表，
 * 前端本身走的还是 main.tsx → App → Workbench 那条真路径，样式、布局、层级
 * 全部由产品代码决定。所以截出来的图能证明布局的事，不能证明后端的事。
 */

export interface StubOptions {
  /** KARA 是否处于工作态：图三那层滤镜只在这时候出现。 */
  readonly kara?: boolean;
  /** 打开发送台（Agent 区），即图一。 */
  readonly dispatch?: boolean;
  readonly theme?: string;
  readonly material?: "solid" | "acrylic" | "liquid";
}

const BLOCKS = [
  "雾从下游漫上来，把河湾一层层收走。他没有回头，只是把手里的册子换到另一只手。",
  "远处有人在敲什么东西。很慢，隔很久才一下，像在给这条河数脉搏。",
  "她留下的信压在砚台底下，边角已经卷起。第三段被水汽浸得发胀，字迹却还在。",
  "他决定在天黑之前走到渡口。雾大的时候，路不在脚下，在记忆里。",
  "渡口的老人认得他，什么也没问，指了指船。船篷上坐着一只湿淋淋的鸟。",
  // 中西混排：混排间距（`inter-script-spacing.ts`）只在 script 边界上插入
  // 间距元素，纯中文语料量到的永远是 0 个——而那与「功能根本没生效」的
  // 输出一模一样。这一段让渲染探针有得可量。
  //
  // **中英之间不能预先打空格**：第一版写的是「他在 Notebook 上」，引擎正确
  // 地判定作者已经手动隔开、无需再插入，于是渲染探针量到 0 个间距——而那
  // 与功能失效的读数完全相同，我差点据此去改一个没有坏的模块。
  "他在Notebook上写下42，又划掉，改成forty-two，最后还是写回了汉字。",
];

/**
 * 注入脚本。必须在页面脚本之前跑（`addInitScript`），因为 `App` 在挂载时
 * 就会调用 `readConfig`。
 */
export function stubScript(options: StubOptions = {}): string {
  const kara = options.kara === true;
  const theme = options.theme ?? "tou";
  const material = options.material ?? "acrylic";
  const blocks = BLOCKS.map((text, i) => ({
    id: `b${i + 1}`,
    text,
    widthUnits: text.length * 2,
    hardLines: 0,
    maxLineUnits: text.length * 2,
    isFence: false,
  }));
  const rows = [
    {
      id: "d1",
      path: "渡口考.md",
      role: "chapter",
      digest: "d1",
      currentHead: "r1",
      headBlockIds: null,
    },
    {
      id: "d2",
      path: "雾河.md",
      role: "chapter",
      digest: "d2",
      currentHead: "r1",
      headBlockIds: null,
    },
  ];
  const karaSession = { started: 1, activity: { kind: "writing" } };
  const karaState = kara ? { kind: "writing", value: { session: karaSession } } : { kind: "off" };

  /*
   * 表里存的是**裸载荷**：generated bindings 的 typedError 自己把结果包成
   * {status,data}，这里再包一层就会变成 data.data，前端拿到的每个字段都是 undefined。
   */
  const table: Record<string, unknown> = {
    health: { version: "0.2.2", commit: null, echo: "ok" },
    display_profile: {
      monitor: "stub",
      physicalWidth: 1440,
      physicalHeight: 900,
      scaleFactor: 1,
      refreshHz: 60,
      refreshMeasured: false,
      frameBudgetMs: 16,
      hairlineCssPx: 1,
    },
    read_config: {
      config: {
        version: 1,
        kara: { autoEntry: "manual" },
        appearance: {
          theme,
          /* 数值逐字取自 crates/refrain-store/src/config.rs 的 Default impl。 */
          typography: {
            fonts: {
              latin: "",
              chinese: "",
              japanese: "",
              priority: ["latin", "chinese", "japanese"],
            },
            text_size_tenths_px: 170,
            font_weight: 400,
            line_height_percent: 190,
            letter_spacing_thousandths_em: 10,
            word_spacing_thousandths_em: 0,
            measure_tenths_em: 346,
            first_line_indent_tenths_em: 0,
            paragraph_spacing_percent: 100,
            alignment: "left",
            page_top_padding_tenths_rem: 30,
            page_bottom_padding_tenths_vh: 500,
            baseline_grid_lines: 0,
            zoom_percent: 100,
          },
          code_theme: "day",
          paper: "paper",
          panel_material: material,
          lamp: "side",
        },
      },
      recoveryEvidence: null,
    },
    list_themes: [
      { id: "tou", label: "\u900f" },
      { id: "sumi", label: "\u58a8" },
    ],
    list_fonts: [],
    list_builtin_typography_presets: [],
    universal_icon: null,
    host_state: { tasks: [], runs: [], recoveryRequired: [], awaitingLaunch: [] },
    kara_state: { state: karaState, autoEntry: "manual", queued: [] },
    kara_event: { machine: { state: karaState, autoEntry: "manual", queued: [] }, effects: [] },
    current_document: { revision: "r1", blocks },
    list_annotations: [],
    list_proposals: [],
    list_agents: [],
    list_harnesses: [],
    list_material_drafts: [],
    review_state: { proposals: [], verdicts: [], cursor: 0, batch: [] },
    // 空数组而不是缺席：信箱拿到 undefined 会在 standings.map 上抛错，
    // 而那个错误没有堆栈指向这里——它看起来像信箱坏了。
    mailbox_standings: [],
    agent_reading_ledger: [],
    preview_dispatch: { manifest: [], digest: "0".repeat(16), requestMd: "" },
  };

  const adopted = {
    rootId: "stub-root",
    backup: { kind: "ready" },
    documents: rows,
    documentTotal: rows.length,
    documentCursor: null,
    openedPath: rows[1]?.path ?? null,
  };

  return `
(() => {
  const TABLE = ${JSON.stringify(table)};
  const ROOT = ${JSON.stringify(adopted)};
  globalThis.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(callback) {
      const id = Math.floor(Math.random() * 1e9);
      globalThis[\`_\${id}\`] = callback;
      return id;
    },
    invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") return Promise.resolve(0);
      if (cmd === "project") {
        const input = args.input;
        if (input.kind === "chooseAndAdoptRoot" || input.kind === "chooseAndCreateProject")
          return Promise.resolve({ kind: "opened", value: ROOT });
        if (input.kind === "documentPage")
          return Promise.resolve({ kind: "page", value: { documents: ROOT.documents, total: ROOT.documents.length, next: null } });
        if (input.kind === "documentSearch")
          return Promise.resolve({ kind: "documents", value: { documents: ROOT.documents, truncated: false } });
        if (input.kind === "blockSearch")
          return Promise.resolve({ kind: "blocks", value: { blocks: [], truncated: false } });
        if (input.kind === "deleteDocument")
          return Promise.resolve({ kind: "deleted", value: ROOT.documents.find((row) => row.path === input.value.path) ?? ROOT.documents[0] });
        if (input.kind === "setDisclosure")
          return Promise.resolve({ kind: "disclosureSet", value: { ...(ROOT.documents.find((row) => row.path === input.value.path) ?? ROOT.documents[0]), disclosure: input.value.disclosure } });
        if (input.kind === "openDocument" || input.kind === "createDocument")
          return Promise.resolve({ kind: "documentOpened", value: {
            document: ROOT.documents.find((row) => row.path === input.value.path) ?? ROOT.documents[1] ?? ROOT.documents[0],
            format: "markdown",
            revision: "r1",
            blocks: TABLE.current_document.blocks,
            stamp: { mtime: 0, size: 0 },
            replayed: 0,
            staleJournal: [],
            kara: null,
          } });
        if (input.kind === "chooseAndImportMaterial" || input.kind === "chooseAndImportManuscript")
          return Promise.resolve({ kind: "imported", value: ROOT.documents[0] });
      }
      const answer = TABLE[cmd];
      /* 没编到的命令一律回 null：图是关于布局的，不是关于后端的。 */
      return Promise.resolve(answer === undefined ? null : answer);
    },
  };
  /* 让 shell 以为已经采纳过一个 Root，直接进工作台而不是欢迎页。 */
  try {
    localStorage.setItem("refrain.root", JSON.stringify(ROOT));
  } catch {}
})();
`;
}
