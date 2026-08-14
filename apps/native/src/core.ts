import { asciiBytes, Cmd, hostRecordBytes, utf8Bytes } from "@native-sdk/core";
import type { FrameEvent, KeyEvent, ScrollState } from "@native-sdk/core/events";
import type { TextCaretDirection, TextInputEvent } from "@native-sdk/core/text";
import {
  ACTION_APPLY_INPUT,
  ACTION_HEALTH,
  ACTION_OBTAIN_PROJECTION,
  ACTION_OPEN_MANUSCRIPT,
  ACTION_PROJECT,
  API_VERSION,
  CAPABILITY_MASK,
  CARET_END,
  CARET_EXTEND_FLAG,
  CARET_NEXT,
  CARET_NEXT_WORD,
  CARET_PREVIOUS,
  CARET_PREVIOUS_WORD,
  CARET_START,
  DEFAULT_VIEWPORT_BLOCKS,
  dispatchResponseAction,
  dispatchResponseApiVersion,
  dispatchResponseCapabilities,
  dispatchResponseFirstBlock,
  dispatchResponseRevision,
  dispatchResponseSession,
  dispatchResponseStatus,
  dispatchResponseText,
  dispatchResponseTotalBlocks,
  dispatchResponseTotalBytes,
  dispatchResponseWindowStart,
  ERROR_DOMAIN_REFUSAL,
  ERROR_HOST_FAILURE,
  ERROR_INVALID_REQUEST,
  ERROR_PROTOCOL_MISMATCH,
  ERROR_STALE_REVISION,
  ERROR_UNKNOWN_SESSION,
  EVENT_TEXT_BYTES,
  INPUT_CANCEL_COMPOSITION,
  INPUT_CLEAR,
  INPUT_COMMIT_COMPOSITION,
  INPUT_DELETE_BACKWARD,
  INPUT_DELETE_FORWARD,
  INPUT_DELETE_WORD_BACKWARD,
  INPUT_DELETE_WORD_FORWARD,
  INPUT_INSERT_TEXT,
  INPUT_MOVE_CARET,
  INPUT_REVERT_TO,
  INPUT_SAVE,
  INPUT_SET_COMPOSITION,
  INPUT_SET_SELECTION,
  INPUT_UNDO,
  isDispatchResponse,
  PROTOCOL_VERSION,
} from "./generated/protocol.ts";
import { afterRefresh, hasRow, NO_ROW, step } from "./roster.ts";
import {
  bytesEqual,
  concatBytes,
  countStringArray,
  countStringFields,
  escapeJson,
  indexOfBytes,
  stringArrayField,
  stringFieldAt,
} from "./wire_json.ts";
import {
  clampRailFraction,
  DESTINATION_DISPATCH,
  DESTINATION_FILES,
  DESTINATION_MANUSCRIPT,
  DESTINATION_REVIEW,
  destinationAt,
  destinationForOrdinal,
  hasRoster,
  isAgentDestination,
  layoutFraction as layoutFractionOf,
  NAVIGATION_CLOSE,
  NAVIGATION_MOVED,
  NAVIGATION_NEEDS_DOCUMENT,
  navigate,
  PANEL_STACK_EMPTY,
  peekStack,
  popDestination,
  popRest,
  pushStack,
  RAIL_FRACTION_DEFAULT,
  settleAfterDocument,
} from "./workbench.ts";

/**
 * 正文轨的宽度余量（px）：列内边距 16×2（app_main.zig `documentView` 的
 * column padding）加分栏拖柄。跨语言各持一份——它不是规则，是同一处
 * 布局常量在两端的影子；改了 documentView 的 padding 就改这里。
 */
const MANUSCRIPT_CHROME_WIDTH_PX = 48;

/**
 * 正文视口的高度余量（px）：列上下 padding 32 + 行距 24 + 状态行约 22。
 * 与 `MANUSCRIPT_CHROME_WIDTH_PX` 同一条纪律。
 */
const MANUSCRIPT_CHROME_HEIGHT_PX = 78;

// 裁决台键盘流（2.1b）在线字节里认的模式。`KIND_FIELD` 走 `quotedField`
// 的旧约定（带引号不带冒号），其余走 `wire_json` 的约定（带冒号）——
// 两个提取器的模式形状不同，各按各的。
const KIND_FIELD = asciiBytes('"kind"');
const PROPOSALS_KIND = asciiBytes("proposals");
const DECIDED_KIND = asciiBytes("decided");
const BLOCKS_KIND = asciiBytes("documentBlocks");
const CONFIG_KIND = asciiBytes("config");
const HOST_KIND = asciiBytes("host");
const COLLECTED_KIND = asciiBytes("collected");
const DISPATCHED_KIND = asciiBytes("dispatched");
const DRAFTS_KIND = asciiBytes("materialDrafts");
const MATERIALS_KIND = asciiBytes("materials");
const KARA_KIND = asciiBytes("kara");
const PREVIEW_KIND = asciiBytes("dispatchPreview");
// KARA 效果的三组提取模式（线形：{"kind":"showReturnCard","value":{"point":
// {…"sentenceTail":"…"}}} 与 {"kind":"interruptNow","value":"save-failed"}）。
const RETURN_CARD_PATTERN = asciiBytes('"kind":"showReturnCard"');
const SENTENCE_TAIL_FIELD = asciiBytes('"sentenceTail":');
const INTERRUPT_VALUE_FIELD = asciiBytes('"kind":"interruptNow","value":');
const NEXT_FIELD = asciiBytes('"next"');
// 在飞判定的三个状态键（v0.2.4：authorized/launching/dispatched 在飞，
// queued 不算）。线是 `{"dispatched":{…}}` 形状，模式带冒号大括号。
const IN_FLIGHT_AUTHORIZED = asciiBytes('"kind":"authorized"');
const IN_FLIGHT_LAUNCHING = asciiBytes('"kind":"launching"');
const IN_FLIGHT_DISPATCHED = asciiBytes('"kind":"dispatched"');
const CODE_FIELD = asciiBytes('"code"');
const ID_FIELD = asciiBytes('"id":');
const AFTER_TEXT_FIELD = asciiBytes('"afterText":');
const STAGED_FIELD = asciiBytes('"staged"');
const DETAIL_FIELD = asciiBytes('"detail":');
const RECOVERY_FIELD = asciiBytes('"recovery"');
const KIND_ACCEPT = asciiBytes("accept");
const KIND_REJECT = asciiBytes("reject");

/**
 * 一行能放下的字身数，随每次文档请求过桥：Rust 按它回禁则断点。
 *
 * 取「作者选的行长」与「视口实测能放下的」的较小者——旧版 DOM 里
 * `max-width: <measure>em` 的同一语义：窗宽足够时行长说了算，窗窄时
 * 版心跟着窗走。实测侧由帧宽 × 分栏投影换算（`layoutFraction` 的分栏表
 * 是唯一权威，这里不抄第二张），字身宽即字号（CJK 全角 advance 恒为 1em）。
 */
function projectionColumnsEm(model: Model): number {
  if (model.typographyTextSize <= 0) return model.typographyMeasureEm;
  const fraction = model.layoutFraction >= 1 ? 1 : 1 - model.layoutFraction;
  const trackPx = model.windowWidth * fraction - MANUSCRIPT_CHROME_WIDTH_PX;
  if (trackPx <= 0) return model.typographyMeasureEm;
  return Math.min(model.typographyMeasureEm, trackPx / model.typographyTextSize);
}

/**
 * 帧高扣掉列 chrome 后的正文视口高（px）。0 表示帧还没到过——滚动布局
 * 在首帧前需要一个值，由 Zig 侧的帧前默认接棒。f64 槽：wholeness 证明
 * 跨函数不折叠（SC4022），证明归 Zig 消费前的真实值域，这里保持 f64。
 */
function viewportHeightPx(model: Model): number {
  if (model.windowHeight <= 0) return 0;
  return Math.max(0, model.windowHeight - MANUSCRIPT_CHROME_HEIGHT_PX);
}

/**
 * 默认主题在生成色表里的下标——濤 `tou`。
 *
 * 与 `generated/themes.zig` 的 `default_index` 同源：两处都由
 * `scripts/generate-themes.ts` 从 `isDefault` 推出，`verify:themes-current`
 * 守着它们不漂开。
 */
const DEFAULT_THEME_INDEX = 0;

/**
 * 生成色表里的主题套数。越界的选择回落到默认。
 *
 * 与 `generated/themes.zig` 的 `themes.len` 同源，`verify:themes-current` 守着
 * 两处不漂开。名字与色值都不在这里——它们住在色表，Model 只记「选了第几套」。
 */
const THEME_COUNT = 7;

/**
 * 把一次主题选择编码成一条设置变更。
 *
 * 复用 project 那条 opaque 通道：设置不另开 action，`ConfigChange` 已经是
 * 完整的设置词汇表，这里只把选中的那一套翻成它的一个变体。
 */
function themeChangeRequest(index: number): Uint8Array {
  // slug 与这段 JSON 都是 ASCII，所以用 SDK 的编码器——core 子集没有
  // `TextEncoder`，而这条限制正好挡住把中文主题名塞进跨界请求。
  // 每个分支各自 return：core 子集把字符串编成定长数组，一个被重新赋值的
  // 变量会以第一个分支的长度定型。switch 的穷尽性同样保证新增一套主题时
  // 这里会被审查。
  switch (index) {
    case 1:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"kasumi"}}');
    case 2:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"suna"}}');
    case 3:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"hua"}}');
    case 4:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"wabi"}}');
    case 5:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"sumi"}}');
    case 6:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"shao"}}');
    default:
      return asciiBytes('{"kind":"changeConfig","value":{"setTheme":"tou"}}');
  }
}

/**
 * 换面板材质的落盘请求（2.10）。与 `themeChangeRequest` 同形：逐分支
 * 预编 ASCII（kebab 词汇与 Rust `PanelMaterial` 的 serde 逐字节一致），
 * 越界回落实心——实心什么都不依赖，永远画得出来（与 Rust 的 Default
 * 同一句理由）。
 */
function materialChangeRequest(index: number): Uint8Array {
  switch (index) {
    case 1:
      return asciiBytes('{"kind":"changeConfig","value":{"setPanelMaterial":"acrylic"}}');
    case 2:
      return asciiBytes('{"kind":"changeConfig","value":{"setPanelMaterial":"liquid"}}');
    default:
      return asciiBytes('{"kind":"changeConfig","value":{"setPanelMaterial":"solid"}}');
  }
}

export interface Model {
  readonly hostReady: boolean;
  readonly status: Uint8Array;
  readonly protocolVersion: number;
  readonly documentSession: number;
  readonly documentRevision: number;
  readonly documentBytes: number;
  readonly documentBlocks: number;
  /**
   * 保存点追踪（2.6 状态行）：保存请求在飞 = savePending；最后一次保存
   * 落地时的 revision = savedRevision。documentRevision != savedRevision
   * 就是「有未保存改动」。保存的答复与打字的答复在响应层同形（无 input
   * 回显），所以保存走自己的通道键 `native-save` 与 save_ok/save_err 臂——
   * 「已保存」必须有正面证据，不能靠「上一次请求是保存」猜。
   */
  readonly savePending: boolean;
  readonly savedRevision: number;
  readonly documentScroll: number;
  readonly viewportFirstBlock: number;
  readonly projectionWindowStart: number;
  readonly projectResult: Uint8Array;
  /**
   * 当前主题的下标，指向 `generated/themes.zig` 的 `themes` 表。
   *
   * 界面状态归 Model（ARCHITECTURE 的 L5 分层纪律），色值归生成的色表——Model 只
   * 记「选了第几套」，不持有任何颜色。切换主题因此是一次 Msg，不是一次样式写入。
   */
  readonly themeIndex: number;
  /**
   * 面板材质的下标（2.10）：0 实心 / 1 亚克力 / 2 液态玻璃。
   * 与 `themeIndex` 同一条纪律：Model 只记下标，语义（透光度、模糊半径、
   * sheen）归 `material.zig` 的配方表。提取只认 config 答复——别的答复里
   * 没有 `panel_material` 字段，提取会回落到 0 把作者的选择冲掉。
   */
  readonly panelMaterial: number;
  /**
   * 作者此刻在哪个去处，指向 `workbench.ts` 的 `DESTINATIONS`。
   *
   * 与 `themeIndex` 同一条纪律：Model 记下标，名字与规则归表。八个去处不写成
   * 八个布尔值——两个布尔可以同时为真，一个下标不可能同时是两个值。
   */
  readonly destinationIndex: number;
  /**
   * 面板栈（旧版 PanelStack 的退层记忆）：去处切换的历史，编码进一个
   * number（3 bit × 8 层）。Escape（panel_back）弹栈退一步；栈空回稿子。
   * 稿子(0) 是根，不进栈。
   */
  readonly panelStack: number;
  /**
   * Agent 区（Cmd+4）记住的上次去处。旧版 QuarterMemory 只记 Agent 层：
   * 另外三层没有可记的分歧。默认派发——原生没有批注面板，派发是 Agent
   * 层最常去的台子。
   */
  readonly agentDestination: number;
  /**
   * 探头态（2.13 悬停开栏）：1 = 功能区是鼠标贴左缘探出来的，此后还没有
   * 任何交互——指针移出整个栏宽时由 `rail_peek_close` 收回（迟滞 = 栏宽：
   * 开 4px、关约 248px，栏不在边缘抖动）。任何交互消息在进 switch 前解除
   * 它：用过的栏留下，解除的只是「自动收回」的资格。Zig 据此决定要不要
   * 给栏 pane 挂 hover_leave 感应面。
   */
  readonly railPeek: number;
  /**
   * 侧栏（文件区）占分栏的比例。作者拖动分隔条时由 `split_resize` 更新——
   * Model 持有它，重建不丢（SDK 的 split 只保存跨重建的位置，不保存到
   * 会话以外）。
   */
  readonly railFraction: number;
  /**
   * 分栏投影：`workbench.ts` 的 `layoutFraction` 算出，Model 持有——
   * 渲染只读这一个值，不在 Zig 侧抄第二张表（抄一份就会漂成两份判断）。
   * 去处或侧栏宽度变化时由 `relayout` 统一重算。
   */
  readonly layoutFraction: number;
  /**
   * 正文字号（px）。来自 Rust `TypographyConfig.text_size_tenths_px`
   * （config.rs）经设置答复提取；初值 17 与该结构的 Default 同源——
   * 启动的 readConfig 到达前，首帧按它排。
   */
  readonly typographyTextSize: number;
  /** 行高（字号百分比）。来源与 `typographyTextSize` 同；初值 190。 */
  readonly typographyLineHeightPercent: number;
  /**
   * 作者选的行长（字身）。来源与 `typographyTextSize` 同；初值 65。
   * 它是上限不是定值：实际断行取它与视口实测的较小者
   * （`projectionColumnsEm`，旧版 max-width 语义）。
   */
  readonly typographyMeasureEm: number;
  /**
   * KARA 六态机的当前状态下标（0 off / 1 entering / 2 writing / 3 reviewing
   * / 4 away / 5 leaving，与 kara.rs 的声明序一致）。机器在 Rust（INV-10），
   * 这里只落地答复里读到的名字；2.3 的 veil 与小结带按它渲染。
   */
  readonly karaState: number;
  /**
   * 安静事件的队列掩码：1 已保存 / 2 agent 完成 / 4 提案到达 / 8 索引刷新。
   * 队列住在 Rust 的机器里，每次 KARA 答复把它的内容搬过来；2.3 的离场
   * 小结带按掩码出条目，空掩码出「这一段很安静。」。
   */
  readonly karaQueued: number;
  /**
   * 回来卡开着（「你停在这里：…」）。KARA 从 Away 回来时机器发
   * showReturnCard，卡挂 600ms 自消（kara.card 延迟）。这是舞台规则的
   * 两个浮层豁免之一（Agent 状态恢复卡）。
   */
  readonly karaCard: boolean;
  /** 回来卡的前文（ReturnPoint.sentenceTail，从 KARA 答复提取）。 */
  readonly karaReturnTail: Uint8Array;
  /**
   * 打断码（interruptNow 的 InterruptEvent 线名，空=没有打断）。打断行
   * role=alert，4s 自消（kara.interrupt 延迟）。中文措辞表在 Zig。
   */
  readonly karaInterrupt: Uint8Array;
  /**
   * 跨文档跳块的挂起块序号：-1 表示没有。搜索命中另一份文档时，开文档与
   * 跳块是两次请求——打开答复落地后由它补发跳块投影（v0.2.4 的
   * `selectDocument(path, ordinal) → revealBlock` 串联缝）。
   */
  readonly pendingJumpBlock: number;
  /**
   * 就地裁决饭盒开着的提案 id（空 = 关着）。Alt+A/B 的接受与退回请求在
   * 开盒时由 Zig 预编（提案 id 是变量，core 子集不拼 JSON）——按键只做
   * 一次转发，因此键位与按钮必然送出同一条请求。
   */
  readonly verdictProposal: Uint8Array;
  /** 饭盒开盒时预编的「接受」请求（judgeVerdict accept）。空 = 饭盒关着。 */
  readonly verdictAccept: Uint8Array;
  /** 饭盒开盒时预编的「退回」请求（judgeVerdict reject）。 */
  readonly verdictReject: Uint8Array;
  /** 改后接受的起笔文字（agent 的建议）：裁决名录在载时由 Zig 读出。 */
  readonly verdictSeed: Uint8Array;
  /**
   * 裁决台在看自己的改法还是竞争稿：0 = 自己（A），1 = 竞争稿（B）。
   *
   * 竞争 = 同一份提案名录里 scope 相同的两条（同一段的两种改法；v0.2.4 用
   * baseline 相等判竞争，但 baseline 列不过桥，scope 才是锚的语义）。竞争
   * 稿的查找在 Zig 渲染时做（它有完整的名录解析），这里只记翻到哪面。
   * 移动游标与名录刷新都会把它归零——翻页跟着行走，不跟着台子走。
   */
  readonly reviewPeer: number;
  /**
   * 已记下、随下一次裁决发出的理由。空串也是一条记下的理由（v0.2.4：
   * Enter 记、可留空）——所以「有没有理由」由 `reasonRecorded` 说，不由
   * 字节长度说。判后即清：理由只骑一次裁决，不赖着影响下一条。
   */
  readonly reviewReason: Uint8Array;
  /** 有没有一条记下的理由。与 `reviewReason` 一起写、一起清。 */
  readonly reasonRecorded: boolean;
  /** 理由框开着。开着时 Escape 先关框（panel_back 的分层），不误退面板。 */
  readonly reasonOpen: boolean;
  /** 理由框里正在打的字：开框时从 `reviewReason` 起笔，Enter 才落回去。 */
  readonly reasonDraft: Uint8Array;
  /**
   * 过期提案的冻结原文（Agent 当时读到的字），空 = 没有过期面板。
   *
   * 由 host 在提交裁决被拒绝时过界（`stale-proposal` 的 detail）——作者
   * 拿它对照现在的文字，判断那条建议还成不成立（SPEC 7.4：不静默套用，
   * 也不静默丢弃）。
   */
  readonly staleFrozen: Uint8Array;
  /** 过期提案的恢复步骤码（kebab 串，\n 连接），Zig 按翻译表出中文。 */
  readonly staleRecovery: Uint8Array;
  /**
   * 裁决批次里暂存了几条（proposals 答复的 staged 数组长度）。提交按钮
   * 与 Alt+Enter 的门：0 时不发提交（v0.2.4：「没有入批的裁决。」）。
   */
  readonly stagedCount: number;
  /**
   * 判后自动前进的挂起旗：桌面裁决发出时立起，proposals 答复落地时转成
   * 一次 120ms 的延迟前进（v0.2.4 判后 120ms 光标 +1）。答复才挂延迟而
   * 不是按键就挂——判失败的裁决不该移动作者的注意力。
   */
  readonly reviewAdvanceArmed: boolean;
  /**
   * 当前生效的行长（字身）：`projectionColumnsEm` 的最新值，Model 持有
   * 因为 Zig 的编辑区宽度按它换算像素（宽 = 字身数 × 字号），两处不各算
   * 一遍（各算一遍就会漂成两份规则）。
   */
  readonly documentColumnsEm: number;
  /**
   * 正文视口的像素高：`viewportHeightPx` 的最新值。0 表示帧还没到过，
   * 滚动布局此时按 Zig 侧的帧前默认排（首帧到达即被真实值替换）。
   */
  readonly documentViewportHeight: number;
  /** 最近一帧的窗口像素尺寸（SDK `frameMsg` 通道）。0 表示帧还没到过。 */
  readonly windowWidth: number;
  readonly windowHeight: number;
  /**
   * 命令面板是否张着。它不是第九个去处：命令面板浮在当前去处之上，
   * 关掉它作者回到原处，而不是回到某个默认去处。
   */
  readonly paletteOpen: boolean;
  /**
   * 命令面板的过滤词。打开时清空——每次打开都是一次新的「我要去…」，
   * 上次的一半查询会让作者以为面板没刷新。
   */
  readonly paletteQuery: Uint8Array;
  /**
   * 最近一次被拒绝的导航要告诉作者的话。空表示无事。
   *
   * 拒绝必须留下痕迹：默默不动会让作者以为快捷键坏了。这里存的是已编码的
   * ASCII 字节，与 `status` 同一形态——core 子集不允许非 ASCII 进 rodata。
   */
  readonly notice: Uint8Array;
  /**
   * 有没有一条待读的提示。标记只能测布尔，测不了「字节数组非空」，
   * 所以这条与 `notice` 一起写、一起清——两处漂开的表现是空横幅占着位置。
   */
  readonly noticeShown: boolean;
  /**
   * 当前去处的名录里有几行。裁决、派发、信箱、连接共用它——作者一次只在
   * 一个去处，所以四个计数放不满同一时刻。换去处时由快照重新填。
   *
   * 计数与游标分开存，是因为它们的来源不同：计数来自 Rust 快照（跨界事实），
   * 游标来自作者的按键（界面状态）。合成一个对象会让「刷新后游标该去哪」
   * 变成一次赋值而不是一次判断。
   */
  readonly rosterCount: number;
  /**
   * 作者停在名录的第几行。空名录上是 `NO_ROW`（−1），不是 0。
   *
   * 不变量归 `roster.ts`：这个字段只经 `settle`／`step` 写入，所以它永远
   * 指向一个存在的行。四个去处不各写一遍越界钳制——旧前端的四套会话类
   * 正是那样，于是「列表空了游标去哪」有四个答案。
   */
  readonly rosterCursor: number;
  /**
   * 当前打开的 Root 的 id，没有打开时是空。
   *
   * **接上哪个功能**：除主题外的每一条产品入口——文件树、搜索、导入、
   * 编排名录都以 Root 为作用域。它由 Rust 的答复给出（`ChooseAndAdoptRoot`
   * 回的 `rootId`），界面原样送回，所以路径始终留在 Rust 里：跨界过河的
   * 是一个不透明 id，不是文件系统路径。
   *
   * 空串表示「还没有打开项目」，而不是「打开了一个没有名字的项目」——
   * 需要 Root 的入口据它决定是发请求还是留下一条可读的拒绝。
   */
  readonly rootId: Uint8Array;
  /**
   * 文件树已经读到哪一页的末尾，空表示还没读或已经读完。
   *
   * 分页游标由 Rust 给（`documentCursor`／`next`），界面原样送回。自己
   * 按行数算下一页会在名录变动时错位——那正是「翻页丢一行」的来源。
   */
  readonly documentCursor: Uint8Array;
  /**
   * 项目里一共有多少份文档，包括没装进这一页的。
   *
   * 这一页**画了几行**不在 Model 里：那是答复里 `documents` 那个数组自己
   * 的长度，Zig 当场数就行（`snapshot.Array.count`）。曾经这里有一个
   * `documentCount` 字段，它去答复里找一个名叫 `"documentCount"` 的字段——
   * 而 Rust 从来没发过这个名字，于是它恒为 0，文件树恒画零行：
   * 作者打开项目以后什么也看不见。一个事实只能有一个权威，而行数
   * 的权威是那个数组本身。
   */
  readonly documentTotal: number;
  /**
   * 搜索框里此刻的字。
   *
   * **接上哪个功能**：`DocumentSearch` 与 `BlockSearch`。查询词是作者正在
   * 打的字，所以它必须住在 Model——放在 Zig 的部件状态里，一次重绘就会把
   * 它冲掉，而作者读成的是「输入框自己清空了」。
   *
   * 排序、召回与中文分词规则都在 Rust，这里只承载那几个字节。
   */
  readonly searchQuery: Uint8Array;
  /**
   * 搜索用精确还是宽松。
   *
   * 两档而不是一个「智能」默认：精确搜不到时回退到宽松是 Rust 的规则，
   * 而作者主动选择哪一档是另一回事——把它藏起来，作者无法解释为什么
   * 同一个词有时命中有时不命中。
   */
  readonly searchExact: boolean;
  /** 信箱页签：false 默认列表，true 回收站。住 Model 而不是部件状态：
   *  页签决定下一次「刷新信箱」读哪份投影，两份投影是不同的事实。 */
  readonly mailboxDiscarded: boolean;
  /**
   * 选中的那一行现在够不够得着一个动作。
   *
   * **接上哪个功能**：名录上的取消／重试，以及 Zig 侧那两个按钮的可用性。
   * 不变量归 `roster.ts` 的 `hasRow`：游标在空名录上是 −1，而 −1 不指向
   * 任何一行——按钮据此灰掉，而不是让作者点一次再被 Rust 拒绝。
   */
  readonly rosterHasRow: boolean;
  /**
   * 当前打开的那份文档在 Root 里的相对路径，没打开时是空。
   *
   * **接上哪个功能**：裁决台与提案读取——它们都以「哪一份稿子」为作用域。
   * 正文本身由 Rust 的会话持有（`documentSession`），但那是一个不透明的
   * 数字；跨界要送的是路径，所以界面必须记住自己打开的是哪一份。
   *
   * 与 `documentSession` 分开：会话回答「Rust 那边开着哪一份」，路径回答
   * 「作者以为自己在改哪一份」。两者在打开失败时会短暂不一致，合成一个
   * 就没法表达那一刻。
   */
  readonly documentPath: Uint8Array;
  /**
   * 作者正在改写哪一条提案的 id，没有在改写时是空。
   *
   * **接上哪个功能**：改写型裁决（`accept-modified`）。它与其余三种裁决
   * 不同：接受／拒绝／只评论是一次点击就定的，改写要作者先写出「我要的
   * 是这样」，所以中间有一个状态。
   *
   * **在全局逻辑中负责什么**：区分「在改写」与「不在改写」。空 id 时那块
   * 编辑区不画——一个永远开着的改写框会让作者以为每条都必须改写。
   */
  readonly revisingProposal: Uint8Array;
  /**
   * 改写到什么样了。
   *
   * 以 Agent 建议的 `afterText` 为起点，而不是空白：作者多数时候只想改
   * 其中一两个词，从空白开始等于让他重打一遍。这也让「改写」与「拒绝后
   * 自己重写」保持为两件事。
   */
  readonly revisionText: Uint8Array;
  /**
   * 作者写给 agent 的那句话。
   *
   * **接上哪个功能**：派发去处的「写请求」。它住在 Model 而不是部件状态，
   * 理由与搜索框相同——一次重绘会把作者打了一半的字冲掉。
   *
   * **在全局逻辑中负责什么**：只承载字节。「这段请求够不够清楚」不是界面
   * 能判的；「范围还在不在稿子里」由 Rust 在派发入口判（选中的原文对不回
   * 块就具名拒绝），这里不复制那条规则。
   */
  readonly dispatchPrompt: Uint8Array;
  /**
   * 最近一次设置答复（config）。开槽的理由与 `deskBlocks` 相同：派发台的
   * agent 名录、设置页的字段都读它，而 `projectResult` 只装最近一次答复。
   */
  readonly configReply: Uint8Array;
  /**
   * 最近一次编排快照（host）。派发台的 Run 名录读它——与块清单、设置
   * 各据一槽，谁落地都不冲掉别人。
   */
  readonly deskHost: Uint8Array;
  /**
   * 最近一次预览答复（2.2 的送前核对，审计 #8）。与 `projectResult` 分开：
   * 预览之后点「刷新名录/读取资料」会把公共槽冲掉，digest 随它消失，
   * 送出就静默退化成无核对——专槽让 digest 活到被消费的那一刻。
   * dispatched 答复落地时清空：预览已被这次送出用掉，再送必须重新预览。
   */
  readonly deskPreview: Uint8Array;
  /**
   * 正在行内编辑的材料草稿 id（空 = 没在编辑）。编辑框起笔是草稿正文
   * （随答复带来的 body），落定走 `CommitMaterialDraft` 的 editedBody。
   */
  readonly materialDraftId: Uint8Array;
  /** 材料草稿编辑框里的字。 */
  readonly materialDraftText: Uint8Array;
  /**
   * 资料名录答复（materials）。派发台的资料分区读它——资料的勾选状态
   * 必须跨文件树翻页存活，所以它是独立名录不是文件树的一页。
   */
  readonly deskMaterials: Uint8Array;
  /**
   * 本轮派发勾选的资料：Root 相对路径，\n 分隔（路径不含换行）。
   * 只有路径过河——档位（disclosure）的唯一权威在 Rust 名录，请求
   * 自带档位会让同一份资料的权限有两个说法。
   */
  readonly dispatchMaterials: Uint8Array;
  /**
   * 派发台块清单的最近一页答复（documentBlocks）。与 `projectResult` 分开
   * 开槽：台上同时要看块清单、Run 名录与预览清单，而 `projectResult` 只
   * 装最近一次答复——任何一个别的答复落地都会把块清单冲掉。
   */
  readonly deskBlocks: Uint8Array;
  /**
   * 块清单的下一页游标（答复的 `next`），−1 = 没有下一页。答复里 `next`
   * 在场时恒 ≥ 1（首页从 0 起，next = 末行+1），所以 0 不是合法游标，
   * 缺席/null 经 numberField 得 0，落成 −1。
   */
  readonly deskBlocksNext: number;
  /**
   * 块清单勾选的位图：第 i 位 = 第 i 块（ordinal）被勾。派发范围永远是
   * 最小连续覆盖（领域规则：Edit Scope 是一段连续正文），勾不连续的
   * 几行时范围格如实说「覆盖 bX–bY（含中间段）」——比 v0.2.4 的任意
   * 并集诚实，也比它安全（非连续在 Rust 会被具名拒绝）。
   */
  readonly dispatchChecked: Uint8Array;
  /**
   * 带稿模式：0=增量（前几轮的裁决，v0.2.4 默认）、1=全文、2=不带。
   * 三种都归 Rust 解析（全文/裁决都在 Rust 侧），界面只送一个词——
   * 全文不过桥。
   */
  readonly dispatchCarry: number;
  /**
   * 选中的 agent id。空 = 未选：Zig 渲染时默认第一个具名伙伴，一个伙伴
   * 也没有时是「手动往返」L0 兜底行（v0.2.4 同款默认）。
   */
  readonly dispatchAgent: Uint8Array;
  /**
   * 攒进发送的段落：正文右键「攒进发送」一段段攒下的选区原文，NUL
   * 分隔（文本不含 NUL）。送出时每段是一个文本 scope（Rust 的
   * locate_scope 逐段定位）。只记录不打断写作——v0.2.4 的语义，
   * 但补上了它缺的取消入口（逐条丢与清空）。
   */
  readonly dispatchStash: Uint8Array;
  /**
   * 作者写给这条批注的评论草稿。
   *
   * **接上哪个功能**：批注面板的「写评论」。它住在 Model 而不是部件状态，
   * 理由与搜索框相同——一次重绘会把作者打了一半的字冲掉。评论与高亮是
   * 同一族：草稿为空时发送的是高亮，非空才是评论（Rust 的 Annotate 是
   * 唯一权威）。
   */
  readonly annotationDraft: Uint8Array;
  /** 正在编辑 argv 的那个 Agent 的 id。空就是不在编辑。 */
  readonly editingAgent: Uint8Array;
  /** 作者写给这个 Agent 的参数草稿：一段以空格分隔的文本。 */
  readonly agentArgvDraft: Uint8Array;
  /**
   * 这一次派给几个 agent。
   *
   * 多于一个即为并列：它们读同一份请求，各写各的产出，谁先谁后不改变结果。
   * 数字住在 Model 是因为它要在「送出去」那一刻随请求过界，而按钮按下时
   * 界面已经重绘过很多次。
   */
  readonly dispatchAgents: number;
  /**
   * 这几个 agent 之间怎么排：0 并列、1 接力、2 验证。
   *
   * **接上哪个功能**：多 Agent 编排。三种排法对应 `RunEdge` 的三种边，
   * 边的位置由 Rust 的 `edges_for` 算——界面因此不必知道 Run 会以什么
   * 顺序铸出来。
   *
   * 存下标而不是名字：三个名字是中文标签（「并列」「接力」「验证」），
   * 进不了 core 子集的 rodata（NS9001），所以它们住在 Zig 侧的表里。
   */
  readonly dispatchOrchestration: number;
}

export type Msg =
  | { readonly kind: "dispatch_ok"; readonly bytes: Uint8Array }
  | { readonly kind: "dispatch_err"; readonly bytes: Uint8Array }
  /**
   * 保存的答复（2.6）。保存走自己的通道键 `native-save`：与打字共键时，
   * 在飞的保存会被下一次输入顶掉，「已保存」就成了没有证据的说辞。
   * 载荷是与 dispatch_ok 同形的二进制投影回包——落地规则复用，再加上
   * 保存证据（savedRevision）。失败只清在飞标记，不标记已存。
   */
  | { readonly kind: "save_ok"; readonly bytes: Uint8Array }
  | { readonly kind: "save_err"; readonly bytes: Uint8Array }
  | { readonly kind: "document_input"; readonly event: TextInputEvent }
  | { readonly kind: "document_scroll"; readonly scroll: ScrollState }
  /**
   * 一帧的真实窗口像素尺寸。SDK 的 `frameMsg` 通道每帧都来，尺寸没变就
   * 不落地（`frameMsg` 返回 null）——重算行长与视口高只在变化时发生，
   * 变化且稿子开着才连带重投影。
   */
  | { readonly kind: "frame"; readonly width: number; readonly height: number }
  /** 跳到搜索命中的那块：块序号由 Zig 从命中行读出、原样送回——core
   *  没有 JSON 解析器，不自己解读那份答复。 */
  | { readonly kind: "document_jump"; readonly block: number }
  | { readonly kind: "document_undo" }
  /** 回到历史面板选中的那一条动作。id 由 Zig 从快照读出、原样送回——core
   *  没有 JSON 解析器，不自己解读那份答复。 */
  | { readonly kind: "document_revert"; readonly actionId: Uint8Array }
  | { readonly kind: "document_save" }
  | { readonly kind: "project_request"; readonly input: Uint8Array }
  /** Open one document of an adopted Root. `reference` is `rootId\npath`. */
  | { readonly kind: "document_open"; readonly reference: Uint8Array }
  /**
   * 打开另一份文档并跳到命中的那一块。reference 与 `document_open` 同形；
   * block 在打开答复落地后补发（打开之前没有会话，跳块无处着落）。
   */
  | { readonly kind: "document_open_jump"; readonly reference: Uint8Array; readonly block: number }
  /** 选一套主题。`index` 指向生成色表；越界回落到默认。 */
  | { readonly kind: "theme_select"; readonly index: number }
  /** 换一种面板材质。`index` 0/1/2 = 实心/亚克力/液态玻璃；越界回落实心。 */
  | { readonly kind: "material_select"; readonly index: number }
  /** 换下一套主题，到末尾回到第一套。工具栏与真像素验收都走它。 */
  | { readonly kind: "theme_next" }
  /**
   * 退出应用。接的是 SDK 的 `Cmd.quitApp()`，走最后一扇窗关闭的同一条收尾链：
   * 停止钩子只跑一次，录制中的会话在这里封口 journal。
   * 全局逻辑里它是唯一的正常出口——没有它，进程只能被信号杀掉，
   * 而被杀掉的录制留不下结束标记，回放会判 `JournalTruncated`。
   */
  | { readonly kind: "app_quit" }
  /** 去某个去处。`index` 指向 `DESTINATIONS`；越界与缺稿子都由 `navigate` 判。 */
  | { readonly kind: "workbench_go"; readonly index: number }
  /** 按数字键直达。平台传键位序号（Cmd+1 是 1），下标换算归 `workbench.ts`。
   * 1..4 是四区（设置/文件/编辑/Agent），5..8 直达其余去处。 */
  | { readonly kind: "workbench_key"; readonly ordinal: number }
  /**
   * 贴左缘悬停（2.13）：稿子全宽时左缘 4px 探头条的 hover_enter。开出
   * 探头态功能区——与 Ctrl+2（workbench_key 2）同一个落点，只是不用点、
   * 也不用够键盘。
   */
  | { readonly kind: "rail_peek_open" }
  /**
   * 指针移出探头栏的整个栏宽：栏没被动过（railPeek 仍在）且仍停在文件
   * 去处时收回稿子。迟滞由栏宽提供——开 4px、关约 248px。
   */
  | { readonly kind: "rail_peek_close" }
  /**
   * 面板退一层（Escape / Ctrl+[）。旧版 `PanelStack.back()`：回到上一个去处，
   * 没有上一个时回稿子。
   */
  | { readonly kind: "panel_back" }
  /**
   * 侧栏分隔条被拖动：SDK 的 split 把新 fraction 送进来，Model 持有它
   * （重建不丢、会话外不存）。
   */
  | { readonly kind: "split_resize"; readonly fraction: number }
  /** 开合命令面板。它浮在当前去处之上，不改变去处本身。 */
  | { readonly kind: "palette_toggle" }
  /** 作者读过了那条拒绝提示。 */
  | { readonly kind: "notice_dismiss" }
  /**
   * 无事发生。排版滑杆没跨过一个步距时由 Zig 送这一条——SDK 的
   * ValueMsgFn 必须返回一条 Msg，而「没跨步」的诚实落地就是不动，
   * 不该为它编一条空请求让 Rust 白写一次盘。
   */
  | { readonly kind: "noop" }
  /**
   * 在当前去处的名录里上下移动。裁决、派发、信箱、连接共用这一条。
   *
   * 一条消息而不是四条：四个去处的「下一行」是同一件事，分成四条会让
   * 键盘绑定也分成四份，而它们必然写成同样的内容。
   */
  | { readonly kind: "roster_step"; readonly delta: number }
  /**
   * 搜索框收到一次编辑。
   *
   * 平台的文本通道送的是编辑事件（插入、退格、清空），不是整串——所以
   * 「这次编辑之后框里是什么」必须有人算。算在这里而不是 Zig：它是一条
   * 可在 Null platform 上单测的规则，而 Zig 侧算完再送整串会让同一条规则
   * 有两份实现（正文那条路已经在 Rust 里算了）。
   */
  | { readonly kind: "search_typed"; readonly event: TextInputEvent }
  /**
   * 开始改写一条提案：id 与起点文字都由 Zig 从 Rust 的答复里读出来。
   *
   * 起点是 Agent 建议的改后文字，不是空白——作者多数时候只改一两个词。
   * 起点由调用方给而不是这里查：core 读不了那份不透明答复（没有 JSON
   * 解析器），而 `snapshot.zig` 已经在读它。
   */
  | {
      readonly kind: "revision_begin";
      readonly proposalId: Uint8Array;
      readonly seed: Uint8Array;
    }
  | { readonly kind: "revision_typed"; readonly event: TextInputEvent }
  | { readonly kind: "revision_cancel" }
  /** 作者在派发框里打字。与改写框同一条路径，只是去处不同。 */
  | { readonly kind: "dispatch_typed"; readonly event: TextInputEvent }
  /** 作者在批注面板里写评论草稿。与改写框同一条路径，只是去处不同。 */
  | { readonly kind: "annotation_draft_typed"; readonly event: TextInputEvent }
  /**
   * 开始编辑一个 Agent 的专属 argv：id 与起点都由 Zig 从 Rust 的答复里
   * 读出来。起点是空——快照是借用模式，拼不出现有 argv 的文本；设置项
   * 低频，作者在编辑框里重写完整参数。
   */
  | { readonly kind: "agent_edit_begin"; readonly agentId: Uint8Array }
  | { readonly kind: "agent_argv_typed"; readonly event: TextInputEvent }
  | { readonly kind: "agent_edit_cancel" }
  /** 改派几个 agent。并列的 Run 读同一份请求，各写各的产出。 */
  | { readonly kind: "dispatch_agents"; readonly delta: number }
  /** 换一种排法。三种循环，与去处表同一条纪律：下标在 Model，名字在 Zig。 */
  | { readonly kind: "dispatch_orchestration" }
  /** 勾选/取消勾选清单里的第 ordinal 块（行按钮把序号带来）。 */
  | { readonly kind: "dispatch_block_toggle"; readonly ordinal: number }
  /** 整章：勾上全部块（位图按 documentBlocks 总数铺满）。 */
  | { readonly kind: "dispatch_blocks_all" }
  /** 清空勾选。 */
  | { readonly kind: "dispatch_blocks_clear" }
  /** 换带稿模式：0=增量 1=全文 2=不带。 */
  | { readonly kind: "dispatch_carry"; readonly index: number }
  /** 选中一个 agent（id 由 Zig 从快照读出行）；空 id = 手动往返。 */
  | { readonly kind: "dispatch_agent"; readonly id: Uint8Array }
  /** 勾选/取消勾选一份资料（路径由行按钮带来）。 */
  | { readonly kind: "dispatch_material_toggle"; readonly path: Uint8Array }
  /** 攒进发送：把这段选区原文攒起来（正文右键，只记录不打断写作）。 */
  | { readonly kind: "dispatch_stash"; readonly text: Uint8Array }
  /** 丢掉攒的第 index 段。 */
  | { readonly kind: "dispatch_stash_drop"; readonly index: number }
  /** 清空攒的段落。 */
  | { readonly kind: "dispatch_stash_clear" }
  /**
   * Run 名录的轮询一跳（2500ms）：只在有在飞 Run 时挂着，答复落地时
   * 没有新在飞就不再挂下一跳——链式 setTimeout 语义（v0.2.4 同款），
   * 而不是 setInterval 的空转。
   */
  | { readonly kind: "runs_tick"; readonly at: number }
  /** 开始行内编辑一条材料草稿：id 与起笔（草稿正文）由 Zig 从名录读出。 */
  | {
      readonly kind: "material_draft_begin";
      readonly id: Uint8Array;
      readonly seed: Uint8Array;
    }
  /** 作者在材料草稿编辑框里打字。与改写框同一条 `draftAfterEdit` 路径。 */
  | { readonly kind: "material_draft_typed"; readonly event: TextInputEvent }
  /** 放弃这次材料草稿编辑。 */
  | { readonly kind: "material_draft_cancel" }
  /** 换一档搜索精度。精确与宽松是作者的选择，不是一个藏起来的默认。 */
  | { readonly kind: "search_precision" }
  /**
   * 即打即搜的防抖到点（120ms）：查询词非空就发块级搜索。请求在此拼出
   * （wire_json）——防抖计时器触发时没有任何带数据的 Zig 事件在场。
   * 同 key 重发即重置，所以连续打字只发最后一枪；在飞期间被新请求顶掉
   * 的旧枪不会回话（SDK keyed 替换语义），过期响应因此天然丢。
   */
  | { readonly kind: "search_fire"; readonly at: number }
  /**
   * KARA 专注写作的手动开关。请求字节是定值（manualToggle 无字段），
   * 所以它能住在这里——与设置页按钮同一条消息，两个入口一条路径。
   */
  | { readonly kind: "kara_toggle" }
  /**
   * 窗口焦点（app_main.zig 的 .on_lifecycle 接线）：失焦时若在写作/评审
   * 就挂 8s 的离场判定；回焦时按状态取消或发 returned。
   */
  | { readonly kind: "app_focus"; readonly active: boolean }
  /** 失焦 8s 到点：发 goneAway（机器只在写作/评审听它）。 */
  | { readonly kind: "kara_gone_away"; readonly at: number }
  /** 进场动画到点（700ms）：补发 entered——v0.2.4 从没发过，机器卡 Entering。 */
  | { readonly kind: "kara_entered"; readonly at: number }
  /** 离场 12s 到点：补发 leaveFinished（另一触发是任意输入，2.3 先接计时）。 */
  | { readonly kind: "kara_leave_finished"; readonly at: number }
  /** 回来卡 600ms 自消。 */
  | { readonly kind: "kara_card_done"; readonly at: number }
  /** 打断行 4s 自消。 */
  | { readonly kind: "kara_interrupt_done"; readonly at: number }
  /**
   * 命令面板里在打的过滤词。与搜索框同一条 `searchAfterEdit` 路径——
   * 单行的、只在末尾增删的查询框。过滤本身在 Zig（标签是中文，进不了
   * core 的 rodata）。
   */
  | { readonly kind: "palette_query"; readonly event: TextInputEvent }
  /**
   * 打开就地裁决饭盒：提案 id、预编的接受/退回请求与改写起笔，都由 Zig
   * 在点开印点时读出与编好（core 子集不拼 JSON——预编让 Alt+A/B 的按键
   * 转发与按钮必然送出同一条请求）。
   */
  | {
      readonly kind: "verdict_begin";
      readonly proposalId: Uint8Array;
      readonly accept: Uint8Array;
      readonly reject: Uint8Array;
      readonly seed: Uint8Array;
    }
  /** 接受饭盒里的提案（Alt+A 或按钮）：转发预编的请求。 */
  | { readonly kind: "verdict_accept" }
  /** 退回饭盒里的提案（Alt+B 或按钮）。 */
  | { readonly kind: "verdict_reject" }
  /** 改写饭盒里的提案（Alt+E 或按钮）：起笔是 agent 的建议。 */
  | { readonly kind: "verdict_revise" }
  /** 关掉饭盒（Escape 或点别处）。 */
  | { readonly kind: "verdict_close" }
  /**
   * 翻开/翻回竞争稿（Alt+P）：只翻 `reviewPeer`，竞争稿的查找归 Zig
   * 渲染（它有完整名录）；找不到竞争稿的行按 A 面画。
   */
  | { readonly kind: "review_peer" }
  /**
   * 打开理由框（Alt+R）：起笔是已记下的理由。编辑态的键全放行给输入框
   * （v0.2.4 `intentOf` 的 editing 分支同款）。
   */
  | { readonly kind: "review_reason_open" }
  /** 作者在理由框里打字。与改写框同一条 `draftAfterEdit` 路径。 */
  | { readonly kind: "review_reason_typed"; readonly event: TextInputEvent }
  /** 记下理由（理由框 Enter，on_submit）：空串也记。 */
  | { readonly kind: "review_reason_commit" }
  /** 当作没问过（理由框 Escape）：草稿丢掉，已记下的不动。 */
  | { readonly kind: "review_reason_cancel" }
  /**
   * 落定（Alt+Enter）：改写中 = 把改写落成裁决（饭盒 judgeVerdict／桌面
   * stageVerdict，都是 accept-modified）；否则在裁决台上 = 提交暂存的批次。
   * 请求字节在这里由 `wire_json` 拼出——键盘触发等不到带数据的 Zig 事件，
   * 这是它与饭盒按钮（预编）并存的两条同形路径（wire-shapes 门禁钉住）。
   */
  | { readonly kind: "verdict_settle" }
  /**
   * 判后自动前进（判后 120ms）：裁决答复落地时由 `Cmd.delay` 挂出，
   * 只把游标 +1（clamped 归 roster.ts），不跳过已判——与 v0.2.4 一致。
   */
  | { readonly kind: "review_advance"; readonly at: number }
  /**
   * 裁决台的裁决按钮（接受/退回/只评论/改写落定）：字节由 Zig 在行渲染
   * 时编好；与通用 `project_request` 分开是因为裁决要连带两件事——清掉
   * 已记下的理由（判后即清）与立起判后前进的挂起旗。
   */
  | { readonly kind: "desk_verdict"; readonly request: Uint8Array }
  /** 关掉过期提案面板（按钮或 Escape 分层）。 */
  | { readonly kind: "stale_dismiss" }
  | { readonly kind: "mailbox_tab" };

/**
 * 一个命令 id 变成一条消息。
 *
 * **接上哪个功能**：`app.zon` 声明的快捷键与（步骤 9 之后的）系统菜单。SDK 把
 * 两者都送到这一个入口，所以「⌘3 去裁决」与「菜单里点裁决」必然是同一件事——
 * 旧前端为这两条路各写一份分派，于是它们会漂开。
 *
 * **在全局逻辑中负责什么**：只做 id → Msg 的翻译。「这个去处现在够不够得着」
 * 由 `update` 里的 `navigate` 判，这里不复制那条规则；不认识的 id 返回 `null`，
 * 由 SDK 忽略，而不是猜一个默认动作。
 *
 * **能复用什么**：新增一个命令只加一行这里与一行 `app.zon`。
 * 三平台共用：`primary` 修饰键在 macOS 是 ⌘、在 Windows/Linux 是 Ctrl。
 */
export function commandMsg(name: string): Msg | null {
  // 每个分支各自 return：core 子集把字符串编成定长数组，一个被重新赋值的
  // 变量会以第一个分支的长度定型（NS9001）。
  switch (name) {
    case "go.1":
      return { kind: "workbench_key", ordinal: 1 };
    case "go.2":
      return { kind: "workbench_key", ordinal: 2 };
    case "go.3":
      return { kind: "workbench_key", ordinal: 3 };
    case "go.4":
      return { kind: "workbench_key", ordinal: 4 };
    case "go.5":
      return { kind: "workbench_key", ordinal: 5 };
    case "go.6":
      return { kind: "workbench_key", ordinal: 6 };
    case "go.7":
      return { kind: "workbench_key", ordinal: 7 };
    case "go.8":
      return { kind: "workbench_key", ordinal: 8 };
    case "palette":
      return { kind: "palette_toggle" };
    case "kara.toggle":
      return { kind: "kara_toggle" };
    case "panel.back":
    case "panel.back.bracket":
      return { kind: "panel_back" };
    case "roster.next":
      return { kind: "roster_step", delta: 1 };
    case "roster.previous":
      return { kind: "roster_step", delta: -1 };
    case "document.save":
      return { kind: "document_save" };
    case "document.undo":
      return { kind: "document_undo" };
    case "search":
      // 搜索框住在文件树去处（序号 2）；直达即去那里，不新开去处。
      return { kind: "workbench_key", ordinal: 2 };
    case "theme.next":
      return { kind: "theme_next" };
    case "app.quit":
      return { kind: "app_quit" };
    default:
      return null;
  }
}

/**
 * 一帧落地成一条消息。
 *
 * **接上哪个功能**：行长的视口实测半边（`projectionColumnsEm`）与视口高的
 * 真实值。SDK 每帧都调它，所以这里先做变化检测——尺寸没变返回 null，
 * update 不会被每帧 60 次的空转打扰。
 *
 * **在全局逻辑中负责什么**：只把帧翻译成 Msg。换算规则（分栏表、宽度余量、
 * 字身宽）归 `projectionColumnsEm`／`viewportHeightPx`，这里不复制。
 */
export function frameMsg(model: Model, frame: FrameEvent): Msg | null {
  if (frame.width === model.windowWidth && frame.height === model.windowHeight) return null;
  return {
    kind: "frame",
    // 像素尺寸是整数槽：有序比较排 NaN + 夹上界，Math.trunc 表整（SC4022）。
    width: frame.width >= 0 && frame.width <= 9007199254740991 ? Math.trunc(frame.width) : 0,
    height: frame.height >= 0 && frame.height <= 9007199254740991 ? Math.trunc(frame.height) : 0,
  };
}

/**
 * 一个原始键位变成一条消息。
 *
 * **接上哪个功能**：饭盒的就地裁决键（Alt+A 接受 / Alt+B 退回 / Alt+E
 * 改写，2.1）与裁决台的键盘流（Alt+J/K 移动、Alt+R 理由、Alt+P 竞争稿、
 * Alt+Enter 落定或提交，2.1b，v0.2.4 回迁）。键名由平台小写后送达；
 * 「现在开没开盒、在不在台上」由 update 判（饭盒字段空、游标无行、
 * 栈顶不是裁决台都原地不动），这里只翻译。
 */
export function keyMsg(key: KeyEvent): Msg | null {
  if (!key.alt) return null;
  if (key.key === "a") return { kind: "verdict_accept" };
  if (key.key === "b") return { kind: "verdict_reject" };
  if (key.key === "e") return { kind: "verdict_revise" };
  // 裁决台移动与名录键同一条路：Alt+J/K 就是 roster_step（四个去处共用
  // 的游标不变量在 roster.ts），台上台下由 update 按栈顶判。
  if (key.key === "j") return { kind: "roster_step", delta: 1 };
  if (key.key === "k") return { kind: "roster_step", delta: -1 };
  if (key.key === "r") return { kind: "review_reason_open" };
  if (key.key === "p") return { kind: "review_peer" };
  if (key.key === "enter") return { kind: "verdict_settle" };
  return null;
}

export const viewUnbound = [
  // hostReady 由 Zig 的 statusItem 读（状态行徽章），标记里没有绑定它的元素。
  "hostReady",
  // 状态行由 Zig 从保存证据链另构（statuslineText，2.6）；status 只被那行
  // 调试脚手架绑定过，v0.3.0 走查删了它——update 仍写它留作答复记录。
  "status",
  // 握手簿记与文档四件套：修订号是保存证据链的判据，块数由 Zig 的滚动
  // 布局直读 Model（app_main 的 documentLayout）——标记里没有绑定它们的
  // 元素（脚手架的 protocol/revision/blocks/bytes 行已删）。
  "protocolVersion",
  "documentRevision",
  "documentBytes",
  "documentBlocks",
  // Agent 区记忆只服务 update 里的导航换算（workbench_key → 落点），视图不读。
  "agentDestination",
  // 探头态（2.13）：Zig 读它决定栏 pane 挂不挂 hover_leave 感应面——
  // 探头开的栏移出整栏才收回；手动开的栏不自动收。标记里没有绑定它的元素。
  "railPeek",
  // 探头两臂（2.13）由 Zig 的悬停绑定发出（探头条 hover_enter、栏 pane
  // 感应面 hover_leave），标记里没有发它们的元素。
  "rail_peek_open",
  "rail_peek_close",
  // 两个分栏比例由 Zig 的 split 部件读写，标记里没有绑定它们的元素。
  "railFraction",
  "layoutFraction",
  // 保存/撤销/换主题/命令面板：系统菜单与快捷键经 commandMsg 送达，工具栏
  // 按钮是 Zig 画的——v0.3.0 起标记里不再有工具栏行（那一行是脚手架）。
  "document_undo",
  "document_save",
  "theme_next",
  "palette_toggle",
  // 排版滑杆没跨步时的落定消息：Zig 的滑杆闭包发出，update 原样返回 model。
  "noop",
  // KARA 手动开关：快捷键与菜单经 commandMsg 送达，设置页按钮是 Zig 画的。
  "kara_toggle",
  "karaCard",
  "karaReturnTail",
  "karaInterrupt",
  "app_focus",
  "kara_gone_away",
  "kara_entered",
  "kara_leave_finished",
  "kara_card_done",
  "kara_interrupt_done",
  "search_fire",
  "documentSession",
  "documentScroll",
  // 保存点两字段与保存通道两臂（2.6）：状态行由 Zig 画（保存文案与钟点），
  // 答复经保存自己的通道键送达——标记里没有绑定它们的元素。
  "savePending",
  "savedRevision",
  "save_ok",
  "save_err",
  "viewportFirstBlock",
  "projectionWindowStart",
  "projectResult",
  "dispatch_ok",
  "dispatch_err",
  "document_input",
  "document_scroll",
  // 跳块只从搜索结果行发出：块序号在 Rust 答复里，标记里没有绑定它的元素。
  "document_jump",
  // 回档只从历史面板的行发出：行文字与 id 都在 Rust 快照里，标记里没有
  // 绑定它们的元素。
  "document_revert",
  "project_request",
  "document_open",
  // 工具栏只有「换下一套」一个按钮；按下标直选留给设置面板与真像素验收，
  // 目前没有标记绑定它。
  "theme_select",
  // 面板材质的下标与直选臂（2.10）：设置面板三选行由 Zig 画（材质名是中文），
  // 配方表在 material.zig——标记里没有绑定它们的元素。
  "panelMaterial",
  "material_select",
  // 退出只从系统菜单与 ⌘Q/Ctrl+Q 发出，标记里没有按钮绑它——正稿界面上
  // 放一个「退出」按钮会挤占写作空间，而两个入口已覆盖三平台的惯例。
  "app_quit",
  // 主题下标由 Zig 的 `manuscriptTokens` 读去查色表，标记不直接绑它——
  // 界面看到的是颜色，不是下标。
  "themeIndex",
  // 命令面板由 Zig 的 `commandPalette` 画：八个去处的名字是中文，进不了
  // core 子集的 rodata（NS9001），所以开合标志与那条消息都只走 Zig。
  "paletteOpen",
  "paletteQuery",
  "palette_query",
  "workbench_go",
  // 键位序号由平台事件层翻译后送进来；标记里没有键盘绑定语法。
  "workbench_key",
  // 面板退层由平台键位（Escape / Ctrl+[）送进来，与 `workbench_key` 同一条路径。
  "panel_back",
  "panelStack",
  // 侧栏分隔条的拖动由 SDK 的 split 事件送进来（on_resize），Model 持有宽度。
  "split_resize",
  "destinationIndex",
  // 名录的计数与游标：由 dispatch_ok 的答复落地填（提案名录答复按 `"id":`
  // 出现次数计），信箱视图按帧从 Rust 答复解行。
  "rosterCount",
  "rosterCursor",
  // 上下移动由平台键盘事件送进来，与 `workbench_key` 同一条路径。
  "roster_step",
  // 这四个由 Zig 视图消费：文件树与名录的行文字来自 Rust 答复，读法住在
  // `snapshot.zig`。标记里没有绑定它们的元素——界面看到的是一列行，
  // 不是一个 id 或一个计数。（`project_facts` 臂已删：它从无生产者，
  // 同名字段一直由答复落地覆盖。）
  "rootId",
  "documentCursor",
  "documentTotal",
  // 搜索框的字由 Zig 的输入部件送进来；精度键也在 Zig 侧（中文标签）。
  "searchQuery",
  "searchExact",
  "search_typed",
  "search_precision",
  // 信箱页签由 Zig 的页签按钮切换，标记里没有绑定它的元素。
  "mailboxDiscarded",
  "mailbox_tab",
  // 由 Zig 侧的按钮可用性消费，标记里没有绑定它的元素。
  "rosterHasRow",
  // 由 Zig 的裁决台消费：它是跨界请求的作用域，不是画出来的东西。
  "documentPath",
  // 改写型裁决的两个字段与三条消息：改写区由 Zig 画（中文按钮与提示），
  // 文字经平台输入通道送进来，与搜索框同一条路径。
  "revisingProposal",
  "revisionText",
  "revision_begin",
  "revision_typed",
  "revision_cancel",
  // 派发框的字与 agent 数：中文标签与「送出去」按钮住在 Zig 侧。
  "dispatchPrompt",
  "dispatchAgents",
  "dispatch_typed",
  "dispatch_agents",
  // 评论草稿与两条消息：评论区由 Zig 画（中文按钮与选区预览），文字经
  // 平台输入通道送进来，与改写框同一条路径。
  "annotationDraft",
  "annotation_draft_typed",
  // 伙伴 argv 编辑的三条消息与两个字段：编辑区由 Zig 画（中文按钮），
  // 草稿文字经平台输入通道送进来，与改写框同一条路径。
  "editingAgent",
  "agentArgvDraft",
  "agent_edit_begin",
  "agent_argv_typed",
  "agent_edit_cancel",
  "dispatchOrchestration",
  "dispatch_orchestration",
  // 帧尺寸与由它换算的行长/视口高：Zig 的编辑区宽度、滚动布局与行高读它们，
  // 标记里没有绑定它们的元素；帧本身只从 SDK 的 frameMsg 通道来。
  "windowWidth",
  "windowHeight",
  "documentColumnsEm",
  "documentViewportHeight",
  "frame",
  // 排版三值：Zig 的编辑区部件（字号/行高）与 core 的行长换算读它们，
  // 设置面板的 ± 按钮经 project_request 直达 Rust，不经过标记绑定。
  "typographyTextSize",
  "typographyLineHeightPercent",
  "typographyMeasureEm",
  // KARA 状态下标与安静事件掩码：2.3 的 veil 与小结带由 Zig 画（中文措辞），
  // 值由 core 从 KARA 答复里解出——标记里没有绑定它们的元素。
  "karaState",
  "karaQueued",
  // 跨文档跳块的挂起序号：打开答复落地时由 core 消费，Zig 的搜索命中行
  // 发出 document_open_jump；标记里没有绑定它们的元素。
  "pendingJumpBlock",
  "document_open_jump",
  // 饭盒四字段与五条消息：印点与饭盒由 Zig 画（叠放在编辑区），键位经
  // keyMsg 送达，预编请求由 Zig 在开盒时编好——标记里没有绑定它们的元素。
  "verdictProposal",
  "verdictAccept",
  "verdictReject",
  "verdictSeed",
  "verdict_begin",
  "verdict_accept",
  "verdict_reject",
  "verdict_revise",
  "verdict_close",
  // 裁决台键盘流（2.1b）：游标高亮、理由框、竞争稿与过期面板都由 Zig
  // 画在裁决台视图里，键位经 keyMsg 送达——标记里没有绑定它们的元素。
  "reviewPeer",
  "reviewReason",
  "reasonRecorded",
  "reasonOpen",
  "reasonDraft",
  "staleFrozen",
  "staleRecovery",
  "stagedCount",
  "reviewAdvanceArmed",
  "review_peer",
  "review_reason_open",
  "review_reason_typed",
  "review_reason_commit",
  "review_reason_cancel",
  "verdict_settle",
  "review_advance",
  "desk_verdict",
  "stale_dismiss",
  // 派发深度（2.2）：设置槽、块清单槽、勾选位图、带稿模式、agent 选择
  // 与攒的段落都由 Zig 画在派发台里——标记里没有绑定它们的元素。
  "configReply",
  "deskHost",
  // 预览答复专槽（审计 #8）：digest 活到被消费，Zig 的预览清单与送前核对读它。
  "deskPreview",
  "materialDraftId",
  "materialDraftText",
  "deskBlocks",
  "deskMaterials",
  "dispatchMaterials",
  "deskBlocksNext",
  "dispatchChecked",
  "dispatchCarry",
  "dispatchAgent",
  "dispatchStash",
  "dispatch_block_toggle",
  "dispatch_blocks_all",
  "dispatch_blocks_clear",
  "dispatch_carry",
  "dispatch_agent",
  "dispatch_material_toggle",
  "dispatch_stash",
  "dispatch_stash_drop",
  "dispatch_stash_clear",
  "runs_tick",
  "material_draft_begin",
  "material_draft_typed",
  "material_draft_cancel",
] as const;

/**
 * 一次编辑之后，搜索框里是什么。
 *
 * **接上哪个功能**：搜索框。平台的文本通道送编辑事件而不是整串，所以这条
 * 规则必须有人算；算在 core 里是因为它可以在 Null platform 上单测。
 *
 * **在全局逻辑中负责什么**：只管一个单行查询框，不是正文编辑器——正文的
 * 编辑在 Rust（撤销、块身份、IME 都在那边），这里不复制其中任何一条。
 * 光标与选区不建模：查询框只在末尾增删，这是它与正文的真实差别。
 *
 * 退格按 UTF-8 字符退，不按字节：按字节退会把一个汉字拆成半个，剩下的
 * 字节不是合法 UTF-8，Rust 那边会具名拒绝整条请求。
 */
function searchAfterEdit(current: Uint8Array, event: TextInputEvent): Uint8Array {
  if (event.kind === "clear") return new Uint8Array(0);
  if (event.kind === "insert_text") {
    const next = new Uint8Array(current.length + event.text.length);
    next.set(current, 0);
    next.set(event.text, current.length);
    return next;
  }
  if (event.kind === "delete_backward" || event.kind === "delete_word_backward") {
    if (current.length === 0) return current;
    // 退到上一个字符的起点：UTF-8 的续字节是 0b10xxxxxx（128..191）。
    let cut = current.length - 1;
    while (cut > 0) {
      const byte = current[cut] as number;
      if (byte < 128 || byte > 191) break;
      cut = cut - 1;
    }
    return current.slice(0, cut);
  }
  // 其余编辑（前向删除、移动光标、组字）对一个只在末尾增删的查询框没有
  // 意义，原样返回而不是猜一个动作。
  return current;
}

/**
 * 一次编辑之后，一块多行草稿里是什么。
 *
 * **接上哪个功能**：改写框（`revisionText`）与派发框（`dispatchPrompt`）。
 * 两者是同一类东西——作者临时写的一段字，写好之后整段送出去。
 *
 * **在全局逻辑中负责什么**：与搜索框分开是因为它们的真实差别在换行——
 * 一段草稿可以有多行，而查询框只有一行。与正文编辑器也分开：正文的撤销、
 * 块身份与 IME 都在 Rust，这里一条都不复制。草稿不需要块身份，因为它
 * 还没有进入稿子。
 *
 * 光标与选区不建模：这两块草稿都只在末尾增删，这是它们与正文的真实差别。
 */
function draftAfterEdit(current: Uint8Array, event: TextInputEvent): Uint8Array {
  if (event.kind === "clear") return new Uint8Array(0);
  if (event.kind === "insert_text") {
    const next = new Uint8Array(current.length + event.text.length);
    next.set(current, 0);
    next.set(event.text, current.length);
    return next;
  }
  if (event.kind === "delete_backward" || event.kind === "delete_word_backward") {
    if (current.length === 0) return current;
    // 退到上一个字符的起点：UTF-8 的续字节是 0b10xxxxxx（128..191）。
    // 按字节退会把一个汉字拆成半个，剩下的字节不是合法 UTF-8，Rust 那边
    // 会具名拒绝整条裁决——而作者只是按了一下退格。
    let cut = current.length - 1;
    while (cut > 0) {
      const byte = current[cut] as number;
      if (byte < 128 || byte > 191) break;
      cut = cut - 1;
    }
    return current.slice(0, cut);
  }
  return current;
}

function checkingModel(): Model {
  return {
    hostReady: false,
    status: asciiBytes("Checking the typed Rust boundary..."),
    protocolVersion: 0,
    documentSession: 0,
    documentRevision: 0,
    documentBytes: 0,
    documentBlocks: 0,
    savePending: false,
    savedRevision: 0,
    documentScroll: 0,
    viewportFirstBlock: 0,
    projectionWindowStart: 0,
    projectResult: new Uint8Array(0),
    themeIndex: DEFAULT_THEME_INDEX | 0,
    // 实心：与 Rust `PanelMaterial::default` 同源，readConfig 答复一到即被
    // 作者的真实选择替换。
    panelMaterial: 0,
    // 首启落文件去处而不是稿子：rail（功能区）首帧即开，作者（慢鼠标
    // 画像）第一眼就看到全部入口——文件树、「前往」节、打开项目按钮。
    // 稿子去处没有侧栏，从它起步等于把功能全藏起来（v0.3.0 走查问题 1）。
    destinationIndex: DESTINATION_FILES | 0,
    panelStack: PANEL_STACK_EMPTY | 0,
    agentDestination: DESTINATION_DISPATCH | 0,
    // 探头态初始为无：首启 rail 是正式打开（首帧即开），不是探出来的。
    railPeek: 0,
    railFraction: RAIL_FRACTION_DEFAULT,
    layoutFraction: layoutFractionOf(DESTINATION_FILES, RAIL_FRACTION_DEFAULT),
    // 与 Rust `TypographyConfig::default`（config.rs）同源：启动的
    // readConfig 答复一到即被真实值替换。
    typographyTextSize: 17,
    typographyLineHeightPercent: 190,
    typographyMeasureEm: 65,
    // KARA：启动即 off、无安静事件——机器的真实状态随第一次 KARA 答复落地。
    karaState: 0,
    karaQueued: 0,
    karaCard: false,
    karaReturnTail: new Uint8Array(0),
    karaInterrupt: new Uint8Array(0),
    // 没有挂起的跳块：启动时没有什么可跳的。
    pendingJumpBlock: -1,
    // 饭盒关着：没有提案、没有预编请求、没有起笔。
    verdictProposal: new Uint8Array(0),
    verdictAccept: new Uint8Array(0),
    verdictReject: new Uint8Array(0),
    verdictSeed: new Uint8Array(0),
    // 裁决台：看自己（A 面）、无理由、无过期面板、空批次、不前进。
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
    // 0 = 帧还没到过：视口高由 Zig 帧前默认接棒，窗口尺寸不设先验。
    documentViewportHeight: 0,
    windowWidth: 0,
    windowHeight: 0,
    paletteOpen: false,
    paletteQuery: new Uint8Array(0),
    notice: new Uint8Array(0),
    noticeShown: false,
    rosterCount: 0,
    rosterCursor: NO_ROW | 0,
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
    // 默认增量（v0.2.4 同款）：前几轮的裁决随请求走，全文与不带是选择。
    dispatchCarry: 0,
    dispatchAgent: new Uint8Array(0),
    dispatchStash: new Uint8Array(0),
    annotationDraft: new Uint8Array(0),
    editingAgent: new Uint8Array(0),
    agentArgvDraft: new Uint8Array(0),
    // 默认一个 agent：并列是作者主动选的，不是一个藏起来的默认。
    dispatchAgents: 1,
    // 默认并列：它是唯一不给 Run 之间强加顺序的排法，也是多数时候要的。
    dispatchOrchestration: 0,
  };
}

/**
 * 从项目答复里提取名录事实。
 *
 * **为什么在这里而不在 snapshot.zig**：core 需要 rootId 与分页游标来回答
 * 「有没有项目」「下一页是什么」，而 Zig→core 的 Msg 通道带不了结构载荷
 * （`Cmd.now` 只带时间戳）。曾经的 `project_facts` 臂因此从无生产者，
 * 已删——答复内提取是唯一通路。这是受控的字节提取（模式定位 + 定长
 * 切片），不做 JSON 解析：只认 `"rootId":"…"` 与 `"documentCursor":"…"`
 * 两个引号字段和两个数字字段，认不出的答复保持现状（空字段由调用方
 * 按「没有」处理）。
 */
/** 找 `"<name>":"` 之后的引号字符串。找不到交出空切片。 */
function quotedField(text: Uint8Array, name: Uint8Array): Uint8Array {
  const start = indexOfPattern(text, name);
  if (start < 0) return new Uint8Array(0);
  let cursor = start + name.length;
  while (cursor < text.length && (text[cursor] as number) !== 0x22) cursor += 1; // "
  cursor += 1;
  const begin = cursor;
  while (cursor < text.length && (text[cursor] as number) !== 0x22) cursor += 1;
  return text.slice(begin, cursor);
}

/** 找 `"<name>":` 之后的十进制整数。找不到交出 0。 */
function numberField(text: Uint8Array, name: Uint8Array): number {
  const start = indexOfPattern(text, name);
  if (start < 0) return 0;
  let cursor = start + name.length;
  while (cursor < text.length && (text[cursor] as number) !== 0x3a) cursor += 1; // :
  cursor += 1;
  let value = 0;
  while (
    cursor < text.length &&
    (text[cursor] as number) >= 0x30 &&
    (text[cursor] as number) <= 0x39
  ) {
    value = value * 10 + ((text[cursor] as number) - 0x30);
    cursor += 1;
  }
  return value;
}

/**
 * `numberField` 的 tenths 变体：170 → 17.0（tenths_px → px、tenths_em → em）。
 * 独立一份而不是除以 `numberField` 的返回值——函数的返回槽是整数锁定的
 * （documentTotal 那边按整数用），对它做除法会把分数流进整数槽（NS1016）。
 * 累加器以 0.0 播种：这个局部从出生就是分数，除法不构成混型。
 */
function tenthsField(text: Uint8Array, name: Uint8Array): number {
  const start = indexOfPattern(text, name);
  if (start < 0) return 0;
  let cursor = start + name.length;
  while (cursor < text.length && (text[cursor] as number) !== 0x3a) cursor += 1; // :
  cursor += 1;
  let value = 0.0;
  while (
    cursor < text.length &&
    (text[cursor] as number) >= 0x30 &&
    (text[cursor] as number) <= 0x39
  ) {
    value = value * 10 + ((text[cursor] as number) - 0x30);
    cursor += 1;
  }
  return value / 10;
}

/** 字节模式定位。找不到交出 -1。 */
function indexOfPattern(text: Uint8Array, pattern: Uint8Array): number {
  if (pattern.length === 0 || pattern.length > text.length) return -1;
  outer: for (let at = 0; at <= text.length - pattern.length; at += 1) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if ((text[at + offset] as number) !== (pattern[offset] as number)) continue outer;
    }
    return at;
  }
  return -1;
}

/**
 * KARA 六态的全名探针，与 kara.rs 的声明序同下标。嵌套写法
 * `"state":{"kind":"…"` 不会撞 `DecisionReport` 的 `"state":"durable"`
 * 那一类平铺标签——后者冒号后是引号，不是花括号。
 */
const KARA_STATE_MARKERS: readonly string[] = [
  '"state":{"kind":"off"',
  '"state":{"kind":"entering"',
  '"state":{"kind":"writing"',
  '"state":{"kind":"reviewing"',
  '"state":{"kind":"away"',
  '"state":{"kind":"leaving"',
];

/** KARA 安静事件的线名，按掩码位序（1/2/4/8）。 */
const KARA_QUIET_MARKERS: readonly string[] = [
  '"save-succeeded"',
  '"agent-completed"',
  '"proposal-arrived"',
  '"index-refreshed"',
];

/** 从 KARA 答复解状态下标。答复里没有 KARA 机器时交出 -1（保持现值）。 */
function karaStateOf(text: Uint8Array): number {
  for (let index = 0; index < KARA_STATE_MARKERS.length; index += 1) {
    if (indexOfPattern(text, asciiBytes(KARA_STATE_MARKERS[index] as string)) >= 0) {
      return index | 0;
    }
  }
  return -1;
}

/** 从 KARA 答复解安静事件队列的掩码。没有 `"queued":[` 时交出 -1（保持现值）。 */
function karaQueuedMask(text: Uint8Array): number {
  const at = indexOfPattern(text, asciiBytes('"queued":['));
  if (at < 0) return -1;
  // 只数到队列的右括号：effects 里也提这些名字（queueForDebrief），它们不是队列。
  let end = at + 10;
  while (end < text.length && (text[end] as number) !== 0x5d) end += 1; // ]
  const queue = text.slice(at, end);
  let mask = 0;
  for (let index = 0; index < KARA_QUIET_MARKERS.length; index += 1) {
    if (indexOfPattern(queue, asciiBytes(KARA_QUIET_MARKERS[index] as string)) >= 0) {
      mask = mask | (1 << index);
    }
  }
  return mask | 0;
}

export function initialModel(): [Model, Cmd<Msg>] {
  const model = checkingModel();
  return [
    model,
    Cmd.request(
      /* @generated:host-service */ "refrain.host",
      hostRecordBytes({
        action: ACTION_HEALTH,
        anchor: 0,
        columnsEm: projectionColumnsEm(model),
        cursor: 0,
        flags: 0,
        focus: 0,
        input: 0,
        protocolVersion: PROTOCOL_VERSION,
        revision: model.documentRevision,
        scrollOffsetY: model.documentScroll,
        session: model.documentSession,
        text: new Uint8Array(0),
        viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
        viewportFirstBlock: model.viewportFirstBlock,
        windowStart: model.projectionWindowStart,
      }),
      { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
    ),
  ];
}

/**
 * update 恒返 `[Model, Cmd<Msg>]`——不用 SDK 文档里的混形糖
 * （`Model | [Model, Cmd]`，「裸 Model 是 [model, Cmd.none] 的糖」）。
 *
 * 原因（v0.3.0 真窗首派崩溃）：facade 对混形的窄化靠编译产物里的
 * `Array.isArray`，ScriptC 车道上它对元组返回假，凡带 Cmd 的臂都把
 * 元组本身提交成模型，下一次 model_snapshot 保留到 0x0/0x1——窗口
 * 一收到第一条 Msg 即段错误，null 平台与 node 车道全程不可见。
 * 恒元组让 facade 走 `pair[0]/pair[1]` 无窄化路径（与 initialModel 同，
 * 那条路径 boot 已证明可靠）。「这一臂没有效果」写作 `[model, Cmd.none]`，
 * 不许写裸 `return model`。回归闸：app_main.zig 的
 * 「compiled lane: bare-sugar-free update snapshots after tuple and
 * bare arms alike」。
 */
export function update(previous: Model, msg: Msg): [Model, Cmd<Msg>] {
  // 探头态（2.13）的解除在进 switch 之前：任何交互消息都算「作者用过
  // 这栏」——栏留下，解除的只是自动收回的资格。`keepsPeek` 列的是机器
  // 自己的动静（帧、轮询、定时器与答复），它们不解除。
  const model =
    !keepsPeek(msg.kind) && previous.railPeek === 1 ? { ...previous, railPeek: 0 } : previous;
  switch (msg.kind) {
    // 保存答复与打字答复同形（二进制投影回包），落地规则因此完全共用；
    // 差别只在保存证据的盖法，由 msg.kind 分派——子集不许运行时形状测试
    // （NS1041），这是共享一个 case 体而不是递归调 update 的原因。
    case "save_ok":
    case "dispatch_ok": {
      const bytes = msg.bytes;
      if (!isDispatchResponse(bytes) || dispatchResponseStatus(bytes) !== 0) {
        return [
          {
            ...model,
            hostReady: false,
            // 保存通道上的坏答复同样结束这次在飞：卡住「正在保存…」是谎话。
            savePending: msg.kind === "save_ok" ? false : model.savePending,
            status: asciiBytes("Native host returned an invalid contract."),
          },
          Cmd.none,
        ];
      }
      const action = dispatchResponseAction(bytes);
      if (action === ACTION_HEALTH) {
        if (
          dispatchResponseApiVersion(bytes) !== API_VERSION ||
          (dispatchResponseCapabilities(bytes) & CAPABILITY_MASK) !== CAPABILITY_MASK
        ) {
          return [
            {
              ...model,
              hostReady: false,
              status: asciiBytes("Native host capability mismatch."),
            },
            Cmd.none,
          ];
        }
        // 文档由 Zig 的 `document_open` 打开（携带 rootId + 换行 + path
        // 的引用）；这里不再自动补发 open_manuscript——没有文档可开时那
        // 次请求会被 host 具名拒绝，而首次启动根本没有文档（历史遗留：
        // 曾经总有宿主注入的当前文档）。状态行的「请求无效」正是这样
        // 出现的。
        //
        // 握手只发生一次（`initialModel` 发的唯一一条 health），连带把
        // readConfig 发出去：排版三值（字号/行高/行长）与主题名都随它的
        // 答复落地，设置页与正文首帧不必等作者先按一次「读取设置」。
        // 请求字节与 `project_request.zig` 的 `readConfig` 逐字节同形。
        return [
          {
            ...model,
            hostReady: true,
            status: asciiBytes("Rust authority ready."),
            protocolVersion: PROTOCOL_VERSION | 0,
          },
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_PROJECT,
              anchor: 0,
              columnsEm: projectionColumnsEm(model),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: model.documentRevision,
              scrollOffsetY: model.documentScroll,
              session: model.documentSession,
              text: asciiBytes('{"kind":"readConfig"}'),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: model.viewportFirstBlock,
              windowStart: model.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      if (action === ACTION_PROJECT) {
        // 编排快照与设置、项目共用这一条返回路径。名录事实在这里落地：
        // 裁决台的行数、暂存数与游标钳制都从答复字节提取（wire_json），
        // 与 Zig 侧解快照各读各的层——同一答复，两份投影，线形由
        // wire-shapes 门禁钉住所以两侧不会漂开。
        const text = dispatchResponseText(bytes);
        // rootId 空则保留当前的（读设置与 KARA 的答复不带 Root）。
        const rootId = quotedField(text, asciiBytes('"rootId"'));
        // 排版三值只在设置答复里出现（Config 的 serde 原名），其余答复
        // 不带它们——numberField 缺席得 0，0 不是合法值，按「保持现值」
        // 处理。两个 tenths 值走 tenthsField（整数槽的 numberField 不能
        // 进除法，NS1016；tenthsField 的返回槽从出生就是分数）。调整排版
        // 后行长可能变：禁则断点按旧行长算的，连带重投影（与 frame 分支
        // 同一形状，NS1017：Cmd 在分支里现写）。
        const textSizePx = tenthsField(text, asciiBytes('"text_size_tenths_px"'));
        const measureEm = tenthsField(text, asciiBytes('"measure_tenths_em"'));
        const lineHeight = numberField(text, asciiBytes('"line_height_percent"'));
        // 面板材质（2.10）：整份 config 里 `panel_material` 只出现一次。
        // 非 config 答复没有这个字段，提取必须等 configReply 落槽判完再盖
        // （见 landed 的三元）——无字段时 materialField 是空串，bytesEqual
        // 全假、index 算 0，直接盖会把作者的选择冲成实心。
        const materialField = quotedField(text, asciiBytes('"panel_material"'));
        const materialIndex = bytesEqual(materialField, asciiBytes("acrylic"))
          ? 1
          : bytesEqual(materialField, asciiBytes("liquid"))
            ? 2
            : 0;
        // KARA 答复带机器状态；其余答复没有这两个字段，提取器交 -1 保持现值。
        const karaKind = karaStateOf(text);
        const karaQuiet = karaQueuedMask(text);
        // KARA 效果提取：回来卡（showReturnCard → 卡文+600ms 自消）与打断
        // （interruptNow → 码+4s 自消）。回 Off 时三者一起清。
        const karaReply = bytesEqual(quotedField(text, KIND_FIELD), KARA_KIND);
        const karaOff = karaReply && karaKind === 0;
        const showCard = karaReply && indexOfBytes(text, RETURN_CARD_PATTERN, 0) >= 0;
        const tailField = stringFieldAt(text, SENTENCE_TAIL_FIELD, 0);
        const interruptField = stringFieldAt(text, INTERRUPT_VALUE_FIELD, 0);
        // 提案名录答复（裁决台）：行数 = `"id":` 字段的出现次数（每个提案
        // 对象恰一个；staged 数组是裸串不撞模式）。游标钳进新长度——
        // `afterRefresh` 让作者连着判三条不必每次重新找位置；翻看中的
        // 竞争稿归零（名录变了，A/B 跟着行走）。
        const proposalsListing = bytesEqual(quotedField(text, KIND_FIELD), PROPOSALS_KIND);
        const proposalRows = countStringFields(text, ID_FIELD);
        const settledRoster = proposalsListing
          ? afterRefresh(model.rosterCursor, proposalRows)
          : model.rosterCursor;
        const rosterRows = proposalsListing ? proposalRows : model.rosterCount;
        // 块清单答复落自己的槽（deskBlocks）：台上的 Run 名录答复、设置答复
        // 都不该把块清单冲掉。下一页游标：答复里 `next` 恒 ≥ 1，缺席 → −1。
        const blocksListing = bytesEqual(quotedField(text, KIND_FIELD), BLOCKS_KIND);
        const blocksNext = numberField(text, NEXT_FIELD);
        const configReply = bytesEqual(quotedField(text, KIND_FIELD), CONFIG_KIND);
        const hostReply = bytesEqual(quotedField(text, KIND_FIELD), HOST_KIND);
        const draftsReply = bytesEqual(quotedField(text, KIND_FIELD), DRAFTS_KIND);
        const materialsReply = bytesEqual(quotedField(text, KIND_FIELD), MATERIALS_KIND);
        // 预览与送出（审计 #8 的专槽两端）：预览答复落 deskPreview；送出成功
        // （dispatched）清槽——这次预览已被消费，再送必须重新预览。
        const previewReply = bytesEqual(quotedField(text, KIND_FIELD), PREVIEW_KIND);
        const dispatchedReply = bytesEqual(quotedField(text, KIND_FIELD), DISPATCHED_KIND);
        const landed: Model = {
          ...model,
          hostReady: true,
          status: asciiBytes("Rust project use case completed."),
          projectResult: text,
          rootId: rootId.length > 0 ? rootId : model.rootId,
          documentCursor: quotedField(text, asciiBytes('"documentCursor"')),
          // 计数是整数槽（i64）：numberField 的循环改写证明不了 wholeness，
          // 槽位 `| 0` 表整（SC4022，int32 安全的量级）。两个名字在
          // `ProjectOpened` 与 `ProjectPage` 两条答复上同形，所以这里不必先
          // 分辨自己在读哪一条。
          documentTotal: numberField(text, asciiBytes('"documentTotal"')) | 0,
          typographyTextSize: textSizePx > 0 ? textSizePx : model.typographyTextSize,
          typographyLineHeightPercent:
            // 整数槽的三元：整体 `| 0` 表整，与 `panelStack` 分支同一习语。
            (lineHeight > 0 ? lineHeight : model.typographyLineHeightPercent) | 0,
          typographyMeasureEm: measureEm > 0 ? measureEm : model.typographyMeasureEm,
          // 只认 config 答复：别的答复没有 panel_material，提取值无意义。
          panelMaterial: (configReply ? materialIndex : model.panelMaterial) | 0,
          karaState: (karaKind >= 0 ? karaKind : model.karaState) | 0,
          karaQueued: (karaQuiet >= 0 ? karaQuiet : model.karaQueued) | 0,
          karaCard: karaOff ? false : showCard || model.karaCard,
          karaReturnTail: karaOff
            ? new Uint8Array(0)
            : showCard && tailField.found
              ? tailField.value
              : model.karaReturnTail,
          karaInterrupt: karaOff
            ? new Uint8Array(0)
            : interruptField.found
              ? interruptField.value
              : model.karaInterrupt,
          rosterCount: rosterRows | 0,
          rosterCursor: settledRoster | 0,
          rosterHasRow: hasRow(settledRoster, rosterRows),
          stagedCount:
            (proposalsListing ? countStringArray(text, STAGED_FIELD) : model.stagedCount) | 0,
          reviewPeer: proposalsListing ? 0 : model.reviewPeer,
          deskBlocks: blocksListing ? text : model.deskBlocks,
          deskBlocksNext:
            (blocksListing ? (blocksNext > 0 ? blocksNext : -1) : model.deskBlocksNext) | 0,
          configReply: configReply ? text : model.configReply,
          deskHost: hostReply ? text : model.deskHost,
          deskMaterials: materialsReply ? text : model.deskMaterials,
          deskPreview: previewReply
            ? text
            : dispatchedReply
              ? new Uint8Array(0)
              : model.deskPreview,
          // 草稿名录刷新 = 一次成稿/退回落了地：行内编辑态随名录换新收起。
          materialDraftId: draftsReply ? new Uint8Array(0) : model.materialDraftId,
          materialDraftText: draftsReply ? new Uint8Array(0) : model.materialDraftText,
          // 任何一次项目用例成功，上一次失败的说辞就过期了。
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        };
        const recolumned: Model = { ...landed, documentColumnsEm: projectionColumnsEm(landed) };
        // 合并落盘后名录必须重读：已判的提案已被领域层收走，不重读台面
        // 上就停着一排判过的鬼影（v0.2.4 的 onCommitted → refresh 同款）。
        // 顺带说明：正文投影的刷新不在这条链上——投影随下一次滚动/输入
        // 自取新文本，这是既有缝，不在这里改。
        if (bytesEqual(quotedField(text, KIND_FIELD), DECIDED_KIND)) {
          if (model.rootId.length === 0 || model.documentPath.length === 0)
            return [recolumned, Cmd.none];
          return [
            recolumned,
            Cmd.request(
              /* @generated:host-service */ "refrain.host",
              hostRecordBytes({
                action: ACTION_PROJECT,
                anchor: 0,
                columnsEm: projectionColumnsEm(recolumned),
                cursor: 0,
                flags: 0,
                focus: 0,
                input: 0,
                protocolVersion: PROTOCOL_VERSION,
                revision: recolumned.documentRevision,
                scrollOffsetY: recolumned.documentScroll,
                session: recolumned.documentSession,
                text: readProposalsBytes(recolumned),
                viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
                viewportFirstBlock: recolumned.viewportFirstBlock,
                windowStart: recolumned.projectionWindowStart,
              }),
              { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
            ),
          ];
        }
        // 收取与送出之后连锁读一次编排快照：Run 名录与等待队列都变了，
        // 台上的名录与在飞判定都靠这份新快照。
        if (
          bytesEqual(quotedField(text, KIND_FIELD), COLLECTED_KIND) ||
          bytesEqual(quotedField(text, KIND_FIELD), DISPATCHED_KIND)
        ) {
          if (model.rootId.length === 0) return [recolumned, Cmd.none];
          return [
            recolumned,
            Cmd.request(
              /* @generated:host-service */ "refrain.host",
              hostRecordBytes({
                action: ACTION_PROJECT,
                anchor: 0,
                columnsEm: projectionColumnsEm(recolumned),
                cursor: 0,
                flags: 0,
                focus: 0,
                input: 0,
                protocolVersion: PROTOCOL_VERSION,
                revision: recolumned.documentRevision,
                scrollOffsetY: recolumned.documentScroll,
                session: recolumned.documentSession,
                text: readHostBytes(recolumned),
                viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
                viewportFirstBlock: recolumned.viewportFirstBlock,
                windowStart: recolumned.projectionWindowStart,
              }),
              { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
            ),
          ];
        }
        // 编排快照落地：有在飞 Run 就挂 2500ms 的下一跳（链式——没有新在飞
        // 就不挂，轮询自己停下，v0.2.4 的链式 setTimeout 同款）。
        if (hostReply) {
          const inFlight =
            countStringFields(text, IN_FLIGHT_AUTHORIZED) +
            countStringFields(text, IN_FLIGHT_LAUNCHING) +
            countStringFields(text, IN_FLIGHT_DISPATCHED);
          if (inFlight > 0 && model.rootId.length > 0) {
            return [recolumned, Cmd.delay("runs.tick", 2500, "runs_tick")];
          }
          return [recolumned, Cmd.none];
        }
        // KARA 答复：一次至多挂一口钟（优先状态钟——它是机器活下去的腿；
        // 回来卡与打断是自消展示，下一口答复会再挂）。
        if (karaReply) {
          if (karaKind === 1) return [recolumned, Cmd.delay("kara.enter", 700, "kara_entered")];
          if (karaKind === 5) {
            return [recolumned, Cmd.delay("kara.leave", 12000, "kara_leave_finished")];
          }
          if (showCard) return [recolumned, Cmd.delay("kara.card", 600, "kara_card_done")];
          if (interruptField.found) {
            return [recolumned, Cmd.delay("kara.interrupt", 4000, "kara_interrupt_done")];
          }
          return [recolumned, Cmd.none];
        }
        if (
          model.documentSession === 0 ||
          recolumned.documentColumnsEm === model.documentColumnsEm
        ) {
          // 判后前进在答复落地时挂 120ms 延迟（v0.2.4 判后 120ms 光标 +1）。
          // 只在不重投影的路径上挂：重投影的答复会再走一遍这里，而行长
          // 变化只来自排版答复（不是名录答复），两条链实际不相遇。
          if (proposalsListing && model.reviewAdvanceArmed) {
            return [
              { ...recolumned, reviewAdvanceArmed: false },
              Cmd.delay("review.advance", 120, "review_advance"),
            ];
          }
          return [recolumned, Cmd.none];
        }
        return [
          recolumned,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_OBTAIN_PROJECTION,
              anchor: 0,
              columnsEm: projectionColumnsEm(recolumned),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: recolumned.documentRevision,
              scrollOffsetY: recolumned.documentScroll,
              session: recolumned.documentSession,
              text: new Uint8Array(0),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: recolumned.viewportFirstBlock,
              windowStart: recolumned.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      if (
        action !== ACTION_OPEN_MANUSCRIPT &&
        action !== ACTION_APPLY_INPUT &&
        action !== ACTION_OBTAIN_PROJECTION
      ) {
        return [
          { ...model, status: asciiBytes("Native host returned an unknown dispatch action.") },
          Cmd.none,
        ];
      }
      const session = dispatchResponseSession(bytes);
      const revision = dispatchResponseRevision(bytes);
      const totalBytes = dispatchResponseTotalBytes(bytes);
      const totalBlocks = dispatchResponseTotalBlocks(bytes);
      const firstBlock = dispatchResponseFirstBlock(bytes);
      const windowStart = dispatchResponseWindowStart(bytes);
      const landed: Model = relayout({
        ...model,
        hostReady: true,
        // 分隔符是 U+00B7，不是 ASCII：`asciiBytes` 会把这个码元截成另一串
        // 字节，状态行读出乱码。SDK 0.9.0 的 NS1064 在编译期抓住了它，
        // `utf8Bytes` 是同一条边界上的正确编码。
        status: utf8Bytes("100,000 blocks · viewport projection · Rust document authority"),
        documentSession: session >= 0 && session <= 9007199254740991 ? Math.trunc(session) : 0,
        documentRevision: revision >= 0 && revision <= 9007199254740991 ? Math.trunc(revision) : 0,
        // 保存证据：native-save 通道只跑保存，它的落地就是落盘完成的时刻；
        // 打开一份稿子 = 读到磁盘上已保存的样子，保存点同样跟着落地。
        // 其余答复不动保存点——打字把 revision 推过保存点，状态行才说
        // 「有未保存改动」。
        savePending: msg.kind === "save_ok" ? false : model.savePending,
        savedRevision:
          msg.kind === "save_ok" || action === ACTION_OPEN_MANUSCRIPT
            ? revision >= 0 && revision <= 9007199254740991
              ? Math.trunc(revision)
              : 0
            : model.savedRevision,
        documentBytes:
          totalBytes >= 0 && totalBytes <= 9007199254740991 ? Math.trunc(totalBytes) : 0,
        documentBlocks:
          totalBlocks >= 0 && totalBlocks <= 9007199254740991 ? Math.trunc(totalBlocks) : 0,
        viewportFirstBlock:
          firstBlock >= 0 && firstBlock <= 9007199254740991 ? Math.trunc(firstBlock) : 0,
        projectionWindowStart:
          windowStart >= 0 && windowStart <= 9007199254740991 ? Math.trunc(windowStart) : 0,
        // 稿子换了或没了，读稿子的去处就站不住了。让 `settleAfterDocument`
        // 判——它与 `needsDocument` 同源，新增去处时这里不必跟着改；
        // 去处被逐出后分栏投影跟着重算（回稿子全宽）。
        destinationIndex: settleAfterDocument(model.destinationIndex, session !== 0) | 0,
      });
      // 跨文档跳块的第二程：打开答复落地，补发跳块投影。scrollOffsetY 为 0
      // 时 Rust 按块序号锚定视口、越界钳到尾窗——与 document_jump 同一条
      // 规则，界面不自己 clamp。无论会话开没开成，挂起标记都在这一步清掉：
      // 这次串联结束了。
      if (model.pendingJumpBlock < 0 || action !== ACTION_OPEN_MANUSCRIPT) {
        return [landed, Cmd.none];
      }
      if (landed.documentSession === 0) {
        return [{ ...landed, pendingJumpBlock: -1 }, Cmd.none];
      }
      const jumping: Model = {
        ...landed,
        pendingJumpBlock: -1,
        documentScroll: 0,
        viewportFirstBlock: model.pendingJumpBlock | 0,
      };
      return [
        jumping,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(jumping),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: jumping.documentRevision,
            scrollOffsetY: 0,
            session: jumping.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: jumping.viewportFirstBlock,
            windowStart: jumping.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "dispatch_err":
      // 任何失败都先卸掉判后前进旗：判失败的裁决不该移动作者的注意力。
      return [rejectDispatch({ ...model, reviewAdvanceArmed: false }, msg.bytes), Cmd.none];
    case "document_input": {
      if (model.documentSession === 0) return [model, Cmd.none];
      const event = textEventRequest(msg.event);
      if (event === null) {
        return [
          { ...model, status: asciiBytes("The text event exceeded the fixed ABI bound.") },
          Cmd.none,
        ];
      }
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_APPLY_INPUT,
            anchor: event.anchor,
            columnsEm: projectionColumnsEm(model),
            cursor: event.cursor,
            flags: event.flags,
            focus: event.focus,
            input: event.input,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: event.text,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_scroll": {
      const scrolled: Model = { ...model, documentScroll: msg.scroll.offsetY };
      if (model.documentSession === 0 || msg.scroll.offsetY === model.documentScroll) {
        return [scrolled, Cmd.none];
      }
      return [
        scrolled,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(scrolled),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: scrolled.documentRevision,
            scrollOffsetY: scrolled.documentScroll,
            session: scrolled.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: scrolled.viewportFirstBlock,
            windowStart: scrolled.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "frame": {
      // 帧尺寸落地，行长与视口高跟着重算。变化检测在 `frameMsg` 已经做过，
      // 到这里一定是变了。行长变了而稿子开着：禁则断点按旧行长算的，连带
      // 重投影——与 document_scroll 同一形状（NS1017：Cmd 在分支里现写）。
      const reframed: Model = {
        ...model,
        windowWidth: msg.width,
        windowHeight: msg.height,
        documentColumnsEm: projectionColumnsEm({ ...model, windowWidth: msg.width }),
        // 像素高度是 int32 安全的整数槽：槽位 `| 0` 表整（SC4022）。
        documentViewportHeight: viewportHeightPx({ ...model, windowHeight: msg.height }) | 0,
      };
      if (model.documentSession === 0 || reframed.documentColumnsEm === model.documentColumnsEm) {
        return [reframed, Cmd.none];
      }
      return [
        reframed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(reframed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: reframed.documentRevision,
            scrollOffsetY: reframed.documentScroll,
            session: reframed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: reframed.viewportFirstBlock,
            windowStart: reframed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_jump": {
      // 命中跳块：scrollOffsetY 为 0 时 Rust 按块序号锚定视口，越界它钳到
      // 尾窗——界面不自己 clamp，clamping 的规则只有 Rust 一份。
      if (model.documentSession === 0) return [model, Cmd.none];
      const jumped: Model = { ...model, documentScroll: 0, viewportFirstBlock: msg.block };
      return [
        jumped,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(jumped),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: jumped.documentRevision,
            scrollOffsetY: 0,
            session: jumped.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: msg.block,
            windowStart: jumped.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_undo": {
      // NS1017：Cmd 必须在 update 的返回里现写，三条相似的请求不能提成
      // 一个助手——提出去的那份会逃出派发周期，回放对不上。
      if (model.documentSession === 0) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_APPLY_INPUT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: INPUT_UNDO,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_save": {
      if (model.documentSession === 0) return [model, Cmd.none];
      // 保存走自己的通道键：与打字共键时在飞的保存会被下一次输入顶掉，
      // 而「已保存」必须等到 save_ok 这份正面证据（见 Model.savePending）。
      // 请求形状与撤销、回档同源，只是 input 码不同。
      return [
        { ...model, savePending: true },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_APPLY_INPUT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: INPUT_SAVE,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-save", ok: "save_ok", err: "save_err" },
        ),
      ];
    }
    case "save_err":
      // 失败只卸在飞标记：没有落盘就是没有，状态行继续如实说「未保存」。
      return [rejectDispatch({ ...model, savePending: false }, msg.bytes), Cmd.none];
    case "document_revert": {
      // 与撤销、保存同一条请求形状，文本段带历史面板那一行的动作 id。
      if (model.documentSession === 0) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_APPLY_INPUT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: INPUT_REVERT_TO,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: msg.actionId,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_open": {
      // The project use case answered with a Root id and a document path; open
      // that document. `reference` is `rootId\npath` — Rust resolves the
      // absolute path, so no filesystem path is composed here. This is the
      // production route; the harnesses still open via the startup request,
      // which Rust answers from its environment overrides.
      if (msg.reference.length > EVENT_TEXT_BYTES) {
        return [
          { ...model, status: asciiBytes("The document reference exceeded the ABI bound.") },
          Cmd.none,
        ];
      }
      // 记住打开的是哪一份：裁决与提案读取都以它为作用域。引用的形状是
      // `rootId\npath`，所以路径是换行之后那一段。换稿同时清掉派发台的
      // 块清单与勾选（块属于上一份稿子）；攒的段落留着——它是文本 scope，
      // 对新稿子能不能定位由 Rust 在预览时具名说。
      let split = 0;
      while (split < msg.reference.length && msg.reference[split] !== 10) split = split + 1;
      const opening: Model = {
        ...model,
        status: asciiBytes("Opening the chosen document..."),
        documentPath: msg.reference.slice(split + 1),
        deskBlocks: new Uint8Array(0),
        deskBlocksNext: -1,
        dispatchChecked: new Uint8Array(0),
      };
      return [
        opening,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OPEN_MANUSCRIPT,
            anchor: 0,
            columnsEm: projectionColumnsEm(opening),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: 0,
            scrollOffsetY: 0,
            session: 0,
            text: msg.reference,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: 0,
            windowStart: 0,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_open_jump": {
      // 与 `document_open` 同一条路，只是多记一个挂起的块序号：打开答复
      // 落地后由 dispatch_ok 分支补发跳块投影。
      if (msg.reference.length > EVENT_TEXT_BYTES) {
        return [
          { ...model, status: asciiBytes("The document reference exceeded the ABI bound.") },
          Cmd.none,
        ];
      }
      let split = 0;
      while (split < msg.reference.length && msg.reference[split] !== 10) split = split + 1;
      const opening: Model = {
        ...model,
        status: asciiBytes("Opening the chosen document..."),
        documentPath: msg.reference.slice(split + 1),
        pendingJumpBlock: msg.block | 0,
        // 与 document_open 同一条换稿清零：块清单与勾选属于上一份稿子。
        deskBlocks: new Uint8Array(0),
        deskBlocksNext: -1,
        dispatchChecked: new Uint8Array(0),
      };
      return [
        opening,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OPEN_MANUSCRIPT,
            anchor: 0,
            columnsEm: projectionColumnsEm(opening),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: 0,
            scrollOffsetY: 0,
            session: 0,
            text: msg.reference,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: 0,
            windowStart: 0,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "theme_next": {
      // 轮换而不是弹一个列表：七套主题是一个环，工具栏一个按钮就够，
      // 真像素验收也靠它逐套走完。同时落盘——不落盘的话重开又回到濤，
      // 而作者会把那当成主题没保存成功。
      // 界面立刻用新主题，落盘随后——一次写盘失败不该让主题弹回去，
      // 失败会经 dispatch_err 变成一条可见状态。
      const index = (model.themeIndex + 1) % (THEME_COUNT | 0);
      return [
        { ...model, themeIndex: index | 0 },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: themeChangeRequest(index),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "app_quit": {
      // 模型不变：退出不是一次状态迁移，是把收尾交给宿主。
      // `quitApp` 走最后一扇窗关闭的同一条链，停止钩子只跑一次，
      // 录制中的 journal 在那里封口——回放据此判定文件完整。
      // 稿子的落盘归 `document_save`；这里不代它保存，
      // 否则一次退出会静默盖掉作者尚未确认的改动。
      return [model, Cmd.quitApp()];
    }
    case "theme_select": {
      // 只记下标，不碰颜色：色值住在生成色表里，视图按下标去取。越界回落到
      // 默认而不是拒绝——一次坏的选择不该让界面停在无主题状态。
      const index =
        Number.isInteger(msg.index) && msg.index >= 0 && msg.index < (THEME_COUNT | 0)
          ? msg.index
          : DEFAULT_THEME_INDEX | 0;
      return [
        { ...model, themeIndex: index | 0 },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: themeChangeRequest(index),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "material_select": {
      // 与 theme_select 同一条纪律：Model 先记下标（界面立刻换肤），落盘
      // 经 changeConfig；越界回落实心而不是拒绝（material.zig 的 kindFromKebab
      // 同一句）。0..2 之外的下标不存在第三条路。
      const index = Number.isInteger(msg.index) && msg.index >= 0 && msg.index <= 2 ? msg.index : 0;
      return [
        { ...model, panelMaterial: index | 0 },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: materialChangeRequest(index),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "workbench_go": {
      const landed = goTo(model, destinationAt(msg.index), true, model.panelStack);
      // 去处换了分栏就变，行长跟着变；稿子开着而断行还是旧行长的，
      // 连带重投影（NS1017：Cmd 在分支里现写）。
      if (model.documentSession === 0 || landed.documentColumnsEm === model.documentColumnsEm) {
        return [landed, Cmd.none];
      }
      return [
        landed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(landed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: landed.documentRevision,
            scrollOffsetY: landed.documentScroll,
            session: landed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: landed.viewportFirstBlock,
            windowStart: landed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "rail_peek_open": {
      // 悬停开栏（2.13）：只在稿子全宽时有意义——别的好去处下 rail 本来
      // 就在。与 Ctrl+2 同一条落地（goTo → 同样的重投影判据），落点标成
      // 探头态。goTo 压栈对稿子是空操作，Escape 的退层语义不被探头污染。
      if (model.destinationIndex !== DESTINATION_MANUSCRIPT) return [model, Cmd.none];
      const gone = goTo(model, DESTINATION_FILES, true, model.panelStack);
      const peeked: Model = { ...gone, railPeek: 1 };
      if (model.documentSession === 0 || peeked.documentColumnsEm === model.documentColumnsEm) {
        return [peeked, Cmd.none];
      }
      return [
        peeked,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(peeked),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: peeked.documentRevision,
            scrollOffsetY: peeked.documentScroll,
            session: peeked.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: peeked.viewportFirstBlock,
            windowStart: peeked.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "rail_peek_close": {
      // 指针移出整个栏宽：栏没被用过（railPeek 仍在）且仍停在文件去处才
      // 收回稿子——动过（下标已解除）或已经去了别处的，都不抢它的去处。
      if (model.railPeek !== 1 || model.destinationIndex !== DESTINATION_FILES)
        return [model, Cmd.none];
      const landed = relayout({
        ...model,
        destinationIndex: DESTINATION_MANUSCRIPT | 0,
        railPeek: 0,
      });
      if (model.documentSession === 0 || landed.documentColumnsEm === model.documentColumnsEm) {
        return [landed, Cmd.none];
      }
      return [
        landed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(landed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: landed.documentRevision,
            scrollOffsetY: landed.documentScroll,
            session: landed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: landed.viewportFirstBlock,
            windowStart: landed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "workbench_key": {
      const target = destinationForOrdinal(msg.ordinal, model.agentDestination);
      // 不是导航键就原样返回：这条消息也承担「这个键归不归我管」的判断，
      // 免得每个调用点自己先查一遍表。
      if (target < 0) return [model, Cmd.none];
      const landed = goTo(model, target, true, model.panelStack);
      // 与 `workbench_go` 同一条落地：分栏变了行长就变，稿子开着连带重投影。
      if (model.documentSession === 0 || landed.documentColumnsEm === model.documentColumnsEm) {
        return [landed, Cmd.none];
      }
      return [
        landed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(landed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: landed.documentRevision,
            scrollOffsetY: landed.documentScroll,
            session: landed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: landed.viewportFirstBlock,
            windowStart: landed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "panel_back": {
      // 浮层逐层关、一次只关一层：饭盒开着时 Escape 先关饭盒。
      if (model.verdictProposal.length > 0) {
        return [
          {
            ...model,
            verdictProposal: new Uint8Array(0),
            verdictAccept: new Uint8Array(0),
            verdictReject: new Uint8Array(0),
            verdictSeed: new Uint8Array(0),
          },
          Cmd.none,
        ];
      }
      // 其次是最小的编辑态：理由框（当作没问过，已记下的不动）。
      if (model.reasonOpen) {
        return [{ ...model, reasonOpen: false, reasonDraft: new Uint8Array(0) }, Cmd.none];
      }
      // 再是改写框：收回改写，提案回到未判（v0.2.4 编辑态 Escape 同款）。
      if (model.revisingProposal.length > 0) {
        return [
          {
            ...model,
            revisingProposal: new Uint8Array(0),
            revisionText: new Uint8Array(0),
          },
          Cmd.none,
        ];
      }
      // 再是过期面板：它是一次失败的说辞，关掉不影响名录。
      if (model.staleRecovery.length > 0) {
        return [
          {
            ...model,
            staleFrozen: new Uint8Array(0),
            staleRecovery: new Uint8Array(0),
          },
          Cmd.none,
        ];
      }
      // 弹栈退一步；栈空回稿子（旧版 `back()`：退一步，不关整棵路径）。
      // 栈空且已在稿子时原地不动——稿子没有「上一个」。
      const back = popDestination(model.panelStack);
      if (back === model.destinationIndex) return [model, Cmd.none];
      const landed = goTo(model, back, false, popRest(model.panelStack));
      // 退层同样换分栏：与 `workbench_go` 同一条落地。
      if (model.documentSession === 0 || landed.documentColumnsEm === model.documentColumnsEm) {
        return [landed, Cmd.none];
      }
      return [
        landed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(landed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: landed.documentRevision,
            scrollOffsetY: landed.documentScroll,
            session: landed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: landed.viewportFirstBlock,
            windowStart: landed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "split_resize": {
      // 只认文件区的拖动：SDK 的 tween 也会发 on_resize echo（文档明说——
      // 「reflowing both panes exactly as a divider drag would and noting
      // the same on_resize echoes」），面板开合的中间值不是作者意图，
      // 混进 railFraction 会把侧栏宽污染成面板宽（实测 0.19→0.32）。
      if (model.destinationIndex !== DESTINATION_FILES) return [model, Cmd.none];
      const rail = clampRailFraction(msg.fraction);
      if (rail === model.railFraction) return [model, Cmd.none];
      const landed = relayout({ ...model, railFraction: rail });
      // 拖侧栏就是改视口实测：行长逐帧跟着拖柄走（旧版 DOM 的 live
      // reflow 同源），稿子开着连带重投影。
      if (model.documentSession === 0 || landed.documentColumnsEm === model.documentColumnsEm) {
        return [landed, Cmd.none];
      }
      return [
        landed,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: projectionColumnsEm(landed),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: landed.documentRevision,
            scrollOffsetY: landed.documentScroll,
            session: landed.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: landed.viewportFirstBlock,
            windowStart: landed.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "palette_toggle":
      // 开合面板不动去处，也不清提示：作者可能正是因为看到拒绝才打开面板。
      // 打开时清空过滤词——每次打开都是一次新的「我要去…」。
      return [
        {
          ...model,
          paletteOpen: !model.paletteOpen,
          paletteQuery: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "palette_query":
      if (!model.paletteOpen) return [model, Cmd.none];
      return [{ ...model, paletteQuery: searchAfterEdit(model.paletteQuery, msg.event) }, Cmd.none];
    case "kara_toggle": {
      // 手动切换 KARA：与设置页按钮同一条消息，两个入口一条路径。请求
      // 字节与 `project_request.zig` 的 karaStep("manualToggle") 逐字节
      // 同形（wire_shapes 的 karaStep 条目守着）；KARA 机器是全局的，
      // 这条输入不带 rootId。
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: asciiBytes('{"kind":"karaStep","value":{"kind":"manualToggle"}}'),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "app_focus": {
      // 失焦：只在写作(2)/评审(3)里挂 8s 离场判定——别的状态里失焦不算离开。
      if (!msg.active) {
        if (model.karaState !== 2 && model.karaState !== 3) return [model, Cmd.none];
        return [model, Cmd.delay("kara.away", 8000, "kara_gone_away")];
      }
      // 回焦：机器在 Away(4) 说明离场判定已发作过，发 returned 让它回去；
      // 否则那口 8s 的钟可能还挂着，撤掉（对不存在的钟 cancel 是静默的）。
      if (model.karaState === 4) {
        return [
          model,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_PROJECT,
              anchor: 0,
              columnsEm: projectionColumnsEm(model),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: model.documentRevision,
              scrollOffsetY: model.documentScroll,
              session: model.documentSession,
              text: karaStepBytes(asciiBytes("returned")),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: model.viewportFirstBlock,
              windowStart: model.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      return [model, Cmd.cancel("kara.away")];
    }
    case "kara_gone_away": {
      // 钟到点时还在写作/评审才算离开（期间回来过会被撤钟，到这里双保险）。
      if (model.karaState !== 2 && model.karaState !== 3) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: karaStepBytes(asciiBytes("goneAway")),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "kara_entered": {
      // 进场钟到点：还在 Entering(1) 才补发（作者 700ms 内又退出就不发）。
      if (model.karaState !== 1) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: karaStepBytes(asciiBytes("entered")),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "kara_leave_finished": {
      // 离场钟到点：还在 Leaving(5) 才补发（v0.2.4 从没发过，机器卡死）。
      if (model.karaState !== 5) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: karaStepBytes(asciiBytes("leaveFinished")),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "kara_card_done":
      return [
        model.karaCard ? { ...model, karaCard: false, karaReturnTail: new Uint8Array(0) } : model,
        Cmd.none,
      ];
    case "kara_interrupt_done":
      return [
        model.karaInterrupt.length > 0 ? { ...model, karaInterrupt: new Uint8Array(0) } : model,
        Cmd.none,
      ];
    case "verdict_begin":
      // 开盒：id、预编请求与起笔一起落地（全部 Zig 读出与编好）。
      return [
        {
          ...model,
          verdictProposal: msg.proposalId,
          verdictAccept: msg.accept,
          verdictReject: msg.reject,
          verdictSeed: msg.seed,
        },
        Cmd.none,
      ];
    case "verdict_close":
      return [
        {
          ...model,
          verdictProposal: new Uint8Array(0),
          verdictAccept: new Uint8Array(0),
          verdictReject: new Uint8Array(0),
          verdictSeed: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "verdict_accept": {
      // 饭盒开着就走饭盒（预编请求转发）；没开盒轮到裁决台：接受游标行，
      // 字节在此拼出（wire_json）——键盘触发等不到带数据的 Zig 事件，
      // 与行内按钮（Zig 预编）是同形的两条路径。
      if (model.verdictAccept.length > 0) {
        const closed: Model = {
          ...model,
          verdictProposal: new Uint8Array(0),
          verdictAccept: new Uint8Array(0),
          verdictReject: new Uint8Array(0),
          verdictSeed: new Uint8Array(0),
        };
        return [
          closed,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_PROJECT,
              anchor: 0,
              columnsEm: projectionColumnsEm(model),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: model.documentRevision,
              scrollOffsetY: model.documentScroll,
              session: model.documentSession,
              text: model.verdictAccept,
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: model.viewportFirstBlock,
              windowStart: model.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      const accepted = deskProposalId(model);
      if (accepted.length === 0) return [model, Cmd.none];
      return [
        {
          ...model,
          reviewReason: new Uint8Array(0),
          reasonRecorded: false,
          reasonOpen: false,
          reasonDraft: new Uint8Array(0),
          reviewAdvanceArmed: true,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: deskVerdictBytes(model, accepted, KIND_ACCEPT),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "verdict_reject": {
      // 与接受同一条双路：饭盒转发预编，台上接受游标行（退回）。
      if (model.verdictReject.length > 0) {
        const closed: Model = {
          ...model,
          verdictProposal: new Uint8Array(0),
          verdictAccept: new Uint8Array(0),
          verdictReject: new Uint8Array(0),
          verdictSeed: new Uint8Array(0),
        };
        return [
          closed,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_PROJECT,
              anchor: 0,
              columnsEm: projectionColumnsEm(model),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: model.documentRevision,
              scrollOffsetY: model.documentScroll,
              session: model.documentSession,
              text: model.verdictReject,
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: model.viewportFirstBlock,
              windowStart: model.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      const rejected = deskProposalId(model);
      if (rejected.length === 0) return [model, Cmd.none];
      return [
        {
          ...model,
          reviewReason: new Uint8Array(0),
          reasonRecorded: false,
          reasonOpen: false,
          reasonDraft: new Uint8Array(0),
          reviewAdvanceArmed: true,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: deskVerdictBytes(model, rejected, KIND_REJECT),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "verdict_revise": {
      // 饭盒改写：起笔是开盒时读出的 agent 建议。
      if (model.verdictProposal.length > 0) {
        return [
          {
            ...model,
            revisingProposal: model.verdictProposal,
            revisionText: model.verdictSeed,
          },
          Cmd.none,
        ];
      }
      // 裁决台改写（Alt+E）：游标行的提案 id 与 afterText 在这里从名录
      // 答复取出（`wire_json`，逃逸感知）——行内按钮的种子仍由 Zig 在
      // 渲染时读出（`revision_begin`），两条路径同一形状。只评论的提案
      // 没有 afterText：键原地不动，与按钮的灰掉同款。
      if (!deskListingReady(model)) return [model, Cmd.none];
      const reviseId = stringFieldAt(model.projectResult, ID_FIELD, model.rosterCursor);
      const reviseSeed = stringFieldAt(model.projectResult, AFTER_TEXT_FIELD, model.rosterCursor);
      if (!reviseId.found || !reviseSeed.found) return [model, Cmd.none];
      return [
        {
          ...model,
          revisingProposal: reviseId.value,
          revisionText: reviseSeed.value,
        },
        Cmd.none,
      ];
    }
    case "notice_dismiss":
      return [
        model.noticeShown ? { ...model, notice: new Uint8Array(0), noticeShown: false } : model,
        Cmd.none,
      ];
    case "noop":
      // 滑杆没跨步：什么都不做，model 原样返回（引用不变 = 无变化）。
      return [model, Cmd.none];
    case "roster_step": {
      // 只在没有名录的去处上不动：在那里移动一个看不见的游标，等作者回到
      // 台上时位置已经漂了。
      if (!hasRoster(peekStack(model.panelStack))) return [model, Cmd.none];
      // 不变量归 `roster.ts`：这里只落地，不自己判越界。四个去处共用它，
      // 所以「撞到底就停」这条规矩只有一份。`hasRow` 与游标一起写——
      // 两处漂开的表现是一个指着空名录却仍可点的按钮。
      const moved = step(model.rosterCursor, msg.delta, model.rosterCount) | 0;
      // 换了一行就翻回 A 面：竞争稿的翻看跟着行走，不跟着台子走。
      return [
        {
          ...model,
          rosterCursor: moved,
          rosterHasRow: hasRow(moved, model.rosterCount),
          reviewPeer: 0,
        },
        Cmd.none,
      ];
    }
    case "review_advance": {
      // 判后前进：只 +1，不跳过已判（v0.2.4 同款）。名录在判后答复里已经
      // 重新钳过，这里只是在新的长度上再走一步。
      const moved = step(model.rosterCursor, 1, model.rosterCount) | 0;
      return [
        {
          ...model,
          rosterCursor: moved,
          rosterHasRow: hasRow(moved, model.rosterCount),
          reviewPeer: 0,
        },
        Cmd.none,
      ];
    }
    case "review_peer": {
      if (peekStack(model.panelStack) !== DESTINATION_REVIEW) return [model, Cmd.none];
      if (!model.rosterHasRow) return [model, Cmd.none];
      return [{ ...model, reviewPeer: (1 - model.reviewPeer) | 0 }, Cmd.none];
    }
    case "review_reason_open": {
      if (peekStack(model.panelStack) !== DESTINATION_REVIEW) return [model, Cmd.none];
      if (!model.rosterHasRow) return [model, Cmd.none];
      // 起笔是已记下的理由——改上次说的，而不是每次从零写。
      return [{ ...model, reasonOpen: true, reasonDraft: model.reviewReason }, Cmd.none];
    }
    case "review_reason_typed":
      if (!model.reasonOpen) return [model, Cmd.none];
      return [{ ...model, reasonDraft: draftAfterEdit(model.reasonDraft, msg.event) }, Cmd.none];
    case "review_reason_commit":
      // Enter 记：空串也是一条记下的理由（v0.2.4「理由（可留空）」）。
      if (!model.reasonOpen) return [model, Cmd.none];
      return [
        {
          ...model,
          reasonOpen: false,
          reviewReason: model.reasonDraft,
          reasonRecorded: true,
        },
        Cmd.none,
      ];
    case "review_reason_cancel":
      // Escape 当作没问过：草稿丢掉，已记下的那条不动。
      if (!model.reasonOpen) return [model, Cmd.none];
      return [{ ...model, reasonOpen: false, reasonDraft: new Uint8Array(0) }, Cmd.none];
    case "stale_dismiss":
      return [
        {
          ...model,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "desk_verdict": {
      // 桌面裁决按钮：字节由 Zig 在行渲染时编好（含已记下的理由）。发出
      // 即清理由（判后即清）、立起判后前进旗——答复落地时挂 120ms 延迟。
      if (msg.request.length === 0) return [model, Cmd.none];
      return [
        {
          ...model,
          reviewReason: new Uint8Array(0),
          reasonRecorded: false,
          reasonOpen: false,
          reasonDraft: new Uint8Array(0),
          reviewAdvanceArmed: true,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: msg.request,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "verdict_settle": {
      if (model.revisingProposal.length > 0) {
        // 改写落定：作者写的那段成为最终正文。空段不落——按钮侧同款门禁
        // （按钮在文字为空时灰掉），键盘路径在这里换成一行状态说明。
        if (model.revisionText.length === 0) {
          return [
            {
              ...model,
              status: asciiBytes("A modified verdict needs its final text."),
            },
            Cmd.none,
          ];
        }
        // 饭盒的落定走 judgeVerdict（判了即落盘，回到写作）；裁决台的落定
        // 走 stageVerdict（进批次，等合并）。请求字节在此拼出——与按钮的
        // Zig 预编同形，wire-shapes 门禁钉住两侧。
        const bento = model.verdictProposal.length > 0;
        const settled: Model = {
          ...model,
          revisingProposal: new Uint8Array(0),
          revisionText: new Uint8Array(0),
          reviewReason: new Uint8Array(0),
          reasonRecorded: false,
          reasonOpen: false,
          reasonDraft: new Uint8Array(0),
          verdictProposal: new Uint8Array(0),
          verdictAccept: new Uint8Array(0),
          verdictReject: new Uint8Array(0),
          verdictSeed: new Uint8Array(0),
          reviewAdvanceArmed: !bento && peekStack(model.panelStack) === DESTINATION_REVIEW,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        };
        return [
          settled,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            hostRecordBytes({
              action: ACTION_PROJECT,
              anchor: 0,
              columnsEm: projectionColumnsEm(model),
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: model.documentRevision,
              scrollOffsetY: model.documentScroll,
              session: model.documentSession,
              text: revisionSettleBytes(model),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: model.viewportFirstBlock,
              windowStart: model.projectionWindowStart,
            }),
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      // 裁决台上的落定 = 提交暂存的批次。空批次不发——v0.2.4 的措辞是
      // 「没有入批的裁决。」；这里化成一行状态（ASCII 纪律）。
      if (peekStack(model.panelStack) !== DESTINATION_REVIEW) return [model, Cmd.none];
      if (model.stagedCount === 0) {
        return [{ ...model, status: asciiBytes("No staged verdicts to commit.") }, Cmd.none];
      }
      return [
        {
          ...model,
          staleFrozen: new Uint8Array(0),
          staleRecovery: new Uint8Array(0),
        },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: commitVerdictsBytes(model),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "search_typed": {
      // 只承载字节。查询词的分词、召回与排序都在 Rust——界面在这里做一次
      // 「太短就不搜」之类的判断，就会与 Rust 的规则各说各话。
      const query = searchAfterEdit(model.searchQuery, msg.event);
      // 即打即搜：每一下按键把 120ms 的钟重新挂起（同 key 重挂=重置），
      // 停下来才开火。空查询回 idle：撤钟，什么都不发。
      if (query.length === 0) {
        return [{ ...model, searchQuery: query }, Cmd.cancel("search.fire")];
      }
      return [{ ...model, searchQuery: query }, Cmd.delay("search.fire", 120, "search_fire")];
    }
    case "search_fire": {
      // 空查询与没有项目都不发（回 idle 与「还没打开」都不该有结果）。
      if (model.searchQuery.length === 0 || model.rootId.length === 0) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: searchBytes(model),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "search_precision":
      return [{ ...model, searchExact: !model.searchExact }, Cmd.none];
    case "mailbox_tab":
      return [{ ...model, mailboxDiscarded: !model.mailboxDiscarded }, Cmd.none];
    case "revision_begin":
      // 起点是 Agent 建议的改后文字，由调用方从 Rust 答复里读出来传进来。
      // 换一条提案改写会丢掉上一条改到一半的文字——这是对的：那段文字是
      // 针对上一条提案的，留着它会让作者把 A 的改写提交到 B 上。
      return [
        {
          ...model,
          revisingProposal: msg.proposalId,
          revisionText: msg.seed,
        },
        Cmd.none,
      ];
    case "revision_typed":
      // 没在改写时忽略输入。少了这条守卫，一次落错地方的按键会凭空开始
      // 一段没有归属的改写，而它提交时才会被 Rust 拒绝。
      if (model.revisingProposal.length === 0) return [model, Cmd.none];
      return [{ ...model, revisionText: draftAfterEdit(model.revisionText, msg.event) }, Cmd.none];
    case "dispatch_typed":
      return [
        { ...model, dispatchPrompt: draftAfterEdit(model.dispatchPrompt, msg.event) },
        Cmd.none,
      ];
    case "annotation_draft_typed":
      // 与改写框同一条纪律：发送之后草稿保留（作者可能还要再发一条
      // 差不多的），重新框一段字时自己清掉——这里不替他做决定。
      return [
        { ...model, annotationDraft: draftAfterEdit(model.annotationDraft, msg.event) },
        Cmd.none,
      ];
    case "agent_edit_begin":
      // 起点是空（快照是借用模式，拼不出现有 argv 的文本）；换一个
      // Agent 编辑会丢掉上一个改到一半的参数——那是针对上一个的。
      return [{ ...model, editingAgent: msg.agentId, agentArgvDraft: new Uint8Array(0) }, Cmd.none];
    case "agent_argv_typed":
      // 没在编辑时忽略输入。少了这条守卫，一次落错地方的按键会凭空
      // 开始一段没有归属的参数。
      if (model.editingAgent.length === 0) return [model, Cmd.none];
      return [
        { ...model, agentArgvDraft: draftAfterEdit(model.agentArgvDraft, msg.event) },
        Cmd.none,
      ];
    case "agent_edit_cancel":
      // 两个字段一起清。只清 id 会留下一段孤立的参数，下次编辑时它
      // 作为起点冒出来，作者读成的是「上一条的字漏进来了」。
      return [
        {
          ...model,
          editingAgent: new Uint8Array(0),
          agentArgvDraft: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "dispatch_agents": {
      // 钳在 1..4。零个 agent 的派发铸不出 Run，作者看到的是一行永远
      // 等待的 Task；上限是因为并列的 Run 各跑一个真实进程。
      const next = model.dispatchAgents + msg.delta;
      return [{ ...model, dispatchAgents: next < 1 ? 1 : next > 4 ? 4 : next }, Cmd.none];
    }
    case "dispatch_orchestration":
      // 三种循环。越界回落到并列——一个下标指不到的排法会让 Rust 那边
      // 具名拒绝，而作者只是多按了一下。
      return [{ ...model, dispatchOrchestration: (model.dispatchOrchestration + 1) % 3 }, Cmd.none];
    case "dispatch_block_toggle":
      // 翻转位图里的一位；位图按需长长（尾部补零）。
      return [
        { ...model, dispatchChecked: toggledBit(model.dispatchChecked, msg.ordinal) },
        Cmd.none,
      ];
    case "dispatch_blocks_all":
      // 整章 = 按稿子总块数铺满位图（总数是投影给的跨界事实）。
      return [{ ...model, dispatchChecked: allBits(model.documentBlocks) }, Cmd.none];
    case "dispatch_blocks_clear":
      return [{ ...model, dispatchChecked: new Uint8Array(0) }, Cmd.none];
    case "dispatch_carry":
      // 三档直选；越界按下标 0（增量）落——一个指不到的档不该送出。
      return [
        {
          ...model,
          dispatchCarry: (msg.index >= 0 && msg.index <= 2 ? msg.index : 0) | 0,
        },
        Cmd.none,
      ];
    case "dispatch_agent":
      return [{ ...model, dispatchAgent: msg.id }, Cmd.none];
    case "dispatch_material_toggle":
      if (msg.path.length === 0) return [model, Cmd.none];
      return [
        { ...model, dispatchMaterials: toggledLine(model.dispatchMaterials, msg.path) },
        Cmd.none,
      ];
    case "dispatch_stash": {
      if (msg.text.length === 0) return [model, Cmd.none];
      // NUL 分隔：正文不含 NUL。攒是「只记录」——notice 说去了哪里。
      const stash =
        model.dispatchStash.length === 0
          ? msg.text
          : concatBytes([model.dispatchStash, new Uint8Array([0]), msg.text]);
      return [
        {
          ...model,
          dispatchStash: stash,
          notice: utf8Bytes("攒进了下一次派发。"),
          noticeShown: true,
        },
        Cmd.none,
      ];
    }
    case "dispatch_stash_drop":
      return [{ ...model, dispatchStash: stashDrop(model.dispatchStash, msg.index) }, Cmd.none];
    case "dispatch_stash_clear":
      return [{ ...model, dispatchStash: new Uint8Array(0) }, Cmd.none];
    case "runs_tick": {
      // 轮询一跳：读一次编排快照。有没有在飞由答复落地时判——没有新在飞
      // 就不挂下一跳，轮询自己停下。
      if (model.rootId.length === 0) return [model, Cmd.none];
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: readHostBytes(model),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "material_draft_begin":
      // 起笔是草稿正文（随名录答复带来的 body），不是空白——「改」多半
      // 只动几处，从空白开始等于让作者重写一遍。
      return [{ ...model, materialDraftId: msg.id, materialDraftText: msg.seed }, Cmd.none];
    case "material_draft_typed":
      if (model.materialDraftId.length === 0) return [model, Cmd.none];
      return [
        { ...model, materialDraftText: draftAfterEdit(model.materialDraftText, msg.event) },
        Cmd.none,
      ];
    case "material_draft_cancel":
      return [
        {
          ...model,
          materialDraftId: new Uint8Array(0),
          materialDraftText: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "revision_cancel":
      // 两个字段一起清。只清 id 会留下一段孤立的文字，下次改写时它会作为
      // 起点冒出来，作者读成的是「上一条的字漏进来了」。
      return [
        {
          ...model,
          revisingProposal: new Uint8Array(0),
          revisionText: new Uint8Array(0),
        },
        Cmd.none,
      ];
    case "project_request": {
      if (msg.input.length > EVENT_TEXT_BYTES) {
        return [
          { ...model, status: asciiBytes("The project input exceeded the fixed ABI bound.") },
          Cmd.none,
        ];
      }
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          hostRecordBytes({
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: projectionColumnsEm(model),
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: msg.input,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          }),
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
  }
}

/**
 * 一次导航落到 Model 上。
 *
 * **接上哪个功能**：`workbench_go` 与 `workbench_key` 共用它——按钮与快捷键
 * 是同一件事的两个入口，不该有两份落地规则。
 *
 * **在全局逻辑中负责什么**：把 `navigate` 的穷尽结果翻成状态改动。规则本身
 * 住在 `workbench.ts`（可在 Null platform 上单测），这里只负责落地。
 *
 * **能复用什么**：新增去处不必改这里，只改 `DESTINATIONS` 与 `needsDocument`。
 */
/**
 * 哪些消息不算「作者用过探头栏」（2.13）。帧、轮询、定时器与答复是机器
 * 自己的动静——它们不解除探头态；其余一切消息都在进 switch 前解除它。
 * 新消息种类默认解除：漏进这张表的代价是探头栏提前变手动栏，比反向安全。
 */
function keepsPeek(kind: string): boolean {
  switch (kind) {
    case "frame":
    case "runs_tick":
    case "dispatch_ok":
    case "dispatch_err":
    case "save_ok":
    case "save_err":
    case "search_fire":
    case "app_focus":
    case "kara_gone_away":
    case "kara_entered":
    case "kara_leave_finished":
    case "kara_card_done":
    case "kara_interrupt_done":
    case "rail_peek_open":
    case "rail_peek_close":
      return true;
  }
  return false;
}

function relayout(model: Model): Model {
  // 去处或侧栏宽度变了，分栏投影要跟着重算——这里是一处权威的落地：
  // 渲染侧只读 `layoutFraction`，不会在 Zig 侧再抄一份去处→宽度的表。
  // 行长随分栏一起变（视口实测的能放字数），同在这里落地；是否连带
  // 重投影由调用方按「变了且稿子开着」判。
  const landed: Model = {
    ...model,
    layoutFraction: layoutFractionOf(model.destinationIndex, model.railFraction),
  };
  return { ...landed, documentColumnsEm: projectionColumnsEm(landed) };
}

function goTo(model: Model, target: number, remember: boolean, stackAfterPop: number): Model {
  const result = navigate(model.destinationIndex, target, model.documentSession !== 0);
  if (result === NAVIGATION_MOVED) {
    // 到了新去处就清掉上一条拒绝提示，并收起命令面板——面板的用途是选一个
    // 去处，选完它就该让开。
    // 名录也一起清空：新去处的名录还没读，留着上一处的计数会让界面显示
    // 一列并不存在的行，而游标停在其中一行上。计数由 `project_facts` 填。
    // Agent 层去处要记住（Cmd+4 的下一次落点）；上一去处是退层（Escape）的落点。
    const settled = destinationAt(target) | 0;
    return relayout({
      ...model,
      destinationIndex: settled,
      // 前进压栈：压的是**离开**的那个去处（稿子是根，不进栈）。栈顶因此
      // 恒为「当前处的上一层」，Escape 弹出即到，不会原地打转。
      // 退层（Escape）用弹栈后的栈——退回去不换记忆。
      panelStack:
        (remember ? pushStack(model.panelStack, model.destinationIndex) : stackAfterPop) | 0,
      agentDestination: (isAgentDestination(settled) ? settled : model.agentDestination) | 0,
      paletteOpen: false,
      notice: new Uint8Array(0),
      noticeShown: false,
      rosterCount: 0,
      rosterCursor: NO_ROW | 0,
      rosterHasRow: false,
    });
  }
  if (result === NAVIGATION_NEEDS_DOCUMENT) {
    // 拒绝要留下痕迹：默默不动会让作者以为快捷键坏了。去处名不进这条消息
    // ——它是中文，而 core 子集不允许非 ASCII 进 rodata。
    return { ...model, notice: utf8Bytes("先打开一份稿子。"), noticeShown: true };
  }
  if (result === NAVIGATION_CLOSE) {
    // 同键再按 = 关这一层。2.9 的多层语义：关掉的是最上层，下面那层
    // 露出来（空栈回落稿子——根没有「上一层」）。
    return relayout({
      ...model,
      destinationIndex: popDestination(model.panelStack) | 0,
      panelStack: popRest(model.panelStack) | 0,
      paletteOpen: false,
      notice: new Uint8Array(0),
      noticeShown: false,
      rosterCount: 0,
      rosterCursor: NO_ROW | 0,
      rosterHasRow: false,
    });
  }
  return model.paletteOpen ? { ...model, paletteOpen: false } : model;
}

/** 一段字节放进 JSON 字符串槽：两引号夹住转义后的内容。 */
function quotedJson(raw: Uint8Array): Uint8Array {
  return concatBytes([asciiBytes('"'), escapeJson(raw), asciiBytes('"')]);
}

/**
 * 裁决台名录现在可读吗：栈顶是裁决台、游标有行、最新答复是提案名录。
 * 三条缺一，台上的键盘动作都原地不动——键位不该猜一个默认动作。
 */
function deskListingReady(model: Model): boolean {
  if (peekStack(model.panelStack) !== DESTINATION_REVIEW) return false;
  if (!model.rosterHasRow) return false;
  return bytesEqual(quotedField(model.projectResult, KIND_FIELD), PROPOSALS_KIND);
}

/** 游标行的提案 id；名录不可读或行不可考时是空。 */
function deskProposalId(model: Model): Uint8Array {
  if (!deskListingReady(model)) return new Uint8Array(0);
  const field = stringFieldAt(model.projectResult, ID_FIELD, model.rosterCursor);
  return field.found ? field.value : new Uint8Array(0);
}

/**
 * 桌面键盘裁决的请求字节：与 Zig `project_request.zig` 的 `stageVerdict`
 * 逐字节同形（wire-shapes 门禁钉着 Rust 侧的 serde 形状）。理由只在
 * 「记下了」时带上——空串理由也是一条理由，所以看旗标不看长度。
 */
function deskVerdictBytes(model: Model, proposalId: Uint8Array, kind: Uint8Array): Uint8Array {
  return concatBytes([
    asciiBytes('{"kind":"stageVerdict","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes(',"path":'),
    quotedJson(model.documentPath),
    asciiBytes(',"proposalId":'),
    quotedJson(proposalId),
    asciiBytes(',"kind":"'),
    kind,
    asciiBytes('","finalText":null,"reason":'),
    // 与 Zig 写器同一条规则：空理由出 null（写器对空切片出 null）——
    // 两条路径因此逐字节同形，记下的空理由按「无」送出。
    model.reasonRecorded && model.reviewReason.length > 0
      ? quotedJson(model.reviewReason)
      : asciiBytes("null"),
    asciiBytes("}}"),
  ]);
}

/**
 * 改写落定的请求字节：饭盒走 judgeVerdict（判了即落盘，回到写作），
 * 台面走 stageVerdict（进批次等合并）。kind 恒为 accept-modified，
 * 最终正文是作者写下的那段。
 */
function revisionSettleBytes(model: Model): Uint8Array {
  const bento = model.verdictProposal.length > 0;
  return concatBytes([
    bento
      ? asciiBytes('{"kind":"judgeVerdict","value":{"rootId":')
      : asciiBytes('{"kind":"stageVerdict","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes(',"path":'),
    quotedJson(model.documentPath),
    asciiBytes(',"proposalId":'),
    quotedJson(model.revisingProposal),
    asciiBytes(',"kind":"accept-modified","finalText":'),
    quotedJson(model.revisionText),
    asciiBytes(',"reason":'),
    !bento && model.reasonRecorded && model.reviewReason.length > 0
      ? quotedJson(model.reviewReason)
      : asciiBytes("null"),
    asciiBytes("}}"),
  ]);
}

/** 提交批次的请求字节：与 `stageVerdict` 同一张 serde 表。 */
function commitVerdictsBytes(model: Model): Uint8Array {
  return concatBytes([
    asciiBytes('{"kind":"commitVerdicts","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes(',"path":'),
    quotedJson(model.documentPath),
    asciiBytes("}}"),
  ]);
}

/** 重读名录的请求字节：合并落盘后跟着发，收走已判的提案。 */
function readProposalsBytes(model: Model): Uint8Array {
  return concatBytes([
    asciiBytes('{"kind":"readProposals","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes(',"path":'),
    quotedJson(model.documentPath),
    asciiBytes("}}"),
  ]);
}

/** 读编排快照的请求字节：收取/送出/轮询共用这一条。 */
function readHostBytes(model: Model): Uint8Array {
  return concatBytes([
    asciiBytes('{"kind":"readHost","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes("}}"),
  ]);
}

/** KARA 无字段事件的请求字节（manualToggle/entered/returned/goneAway/leaveFinished）。 */
function karaStepBytes(name: Uint8Array): Uint8Array {
  return concatBytes([asciiBytes('{"kind":"karaStep","value":{"kind":"'), name, asciiBytes('"}}')]);
}

/** 块级搜索的请求字节：与 `project_request.zig` 的 search("blockSearch") 同形。 */
function searchBytes(model: Model): Uint8Array {
  return concatBytes([
    asciiBytes('{"kind":"blockSearch","value":{"rootId":'),
    quotedJson(model.rootId),
    asciiBytes(',"query":'),
    quotedJson(model.searchQuery),
    asciiBytes(',"precision":"'),
    model.searchExact ? asciiBytes("exact") : asciiBytes("loose"),
    asciiBytes('"}'),
    asciiBytes("}"),
  ]);
}

/** 翻转位图里的第 ordinal 位；位图按需长长（新字节是零）。 */
function toggledBit(bits: Uint8Array, ordinal: number): Uint8Array {
  if (ordinal < 0) return bits;
  const need = (ordinal >> 3) + 1;
  const next = new Uint8Array(need > bits.length ? need : bits.length);
  next.set(bits, 0);
  next[ordinal >> 3] = (next[ordinal >> 3] as number) ^ (1 << (ordinal & 7));
  return next;
}

/** count 位的满位图（整章勾选）：末字节只铺到 count 为止。 */
function allBits(count: number): Uint8Array {
  if (count <= 0) return new Uint8Array(0);
  const out = new Uint8Array((count + 7) >> 3);
  for (let index = 0; index < out.length; index += 1) out[index] = 0xff;
  const rest = count & 7;
  if (rest !== 0) out[out.length - 1] = (1 << rest) - 1;
  return out;
}

/** \n 分隔清单的翻转：在就删掉，不在就接上。项内不含换行（路径纪律）。 */
function toggledLine(list: Uint8Array, item: Uint8Array): Uint8Array {
  const newline = new Uint8Array([10]);
  let cursor = 0;
  while (cursor <= list.length) {
    const end = indexOfBytes(list, newline, cursor);
    const stop = end < 0 ? list.length : end;
    if (bytesEqual(list.slice(cursor, stop), item)) {
      // 删掉这一行：连同它前面的分隔符（首行则连同后面的）。
      const from = cursor > 0 ? cursor - 1 : cursor;
      const upto = cursor > 0 ? stop : stop + 1;
      return concatBytes([list.slice(0, from), list.slice(upto)]);
    }
    if (end < 0) break;
    cursor = stop + 1;
  }
  return list.length === 0 ? item : concatBytes([list, newline, item]);
}

/** 丢掉 NUL 分隔清单里的第 index 段；序号越界原样不动。 */
function stashDrop(stash: Uint8Array, index: number): Uint8Array {
  if (index < 0 || stash.length === 0) return stash;
  const out = new Uint8Array(stash.length); // 丢一段只会变短
  let at = 0;
  let cursor = 0;
  let current = 0;
  let skipped = false;
  while (cursor <= stash.length) {
    const end = indexOfBytes(stash, new Uint8Array([0]), cursor);
    const stop = end < 0 ? stash.length : end;
    if (current === index) {
      skipped = true;
    } else {
      if (at > 0) {
        out[at] = 0;
        at += 1;
      }
      out.set(stash.slice(cursor, stop), at);
      at += stop - cursor;
    }
    if (end < 0) break;
    cursor = stop + 1;
    current += 1;
  }
  if (!skipped) return stash;
  return out.slice(0, at);
}

function rejectDispatch(model: Model, bytes: Uint8Array): Model {
  if (!isDispatchResponse(bytes)) {
    return { ...model, status: asciiBytes("Native host returned a corrupt failure.") };
  }
  const code = dispatchResponseStatus(bytes);
  if (code === ERROR_PROTOCOL_MISMATCH) {
    return { ...model, hostReady: false, status: asciiBytes("Native protocol mismatch.") };
  }
  if (code === ERROR_INVALID_REQUEST) {
    return { ...model, status: asciiBytes("Native dispatch request was invalid.") };
  }
  if (code === ERROR_UNKNOWN_SESSION) {
    return { ...model, status: asciiBytes("Native document session was unknown.") };
  }
  if (code === ERROR_DOMAIN_REFUSAL) {
    // 项目拒绝现在带结构 JSON（code/action/subject/recovery，2.1b 起）。
    // 过期提案是作者能行动的一种：冻结原文与恢复步骤过界进面板——
    // 不静默套用，也不静默丢弃（SPEC 7.4）。其余码保持通用说明。
    const text = dispatchResponseText(bytes);
    if (bytesEqual(quotedField(text, CODE_FIELD), asciiBytes("stale-proposal"))) {
      const frozen = stringFieldAt(text, DETAIL_FIELD, 0);
      return {
        ...model,
        staleFrozen: frozen.found ? frozen.value : new Uint8Array(0),
        staleRecovery: stringArrayField(text, RECOVERY_FIELD),
        status: asciiBytes("A proposal went stale; compare with the frozen text."),
      };
    }
    return { ...model, status: asciiBytes("Rust refused the document input.") };
  }
  if (code === ERROR_HOST_FAILURE) {
    return { ...model, status: asciiBytes("Native Rust host failed.") };
  }
  if (code === ERROR_STALE_REVISION) {
    const revision = dispatchResponseRevision(bytes);
    return {
      ...model,
      documentRevision: revision >= 0 && revision <= 9007199254740991 ? Math.trunc(revision) : 0,
      status: asciiBytes(
        "Document input raced a newer Rust revision; retry from the current view.",
      ),
    };
  }
  return { ...model, status: asciiBytes("Native dispatch returned an unknown failure.") };
}

/** One text event encoded into the generated input vocabulary. */
interface EncodedTextEvent {
  readonly input: number;
  readonly flags: number;
  readonly anchor: number;
  readonly focus: number;
  readonly cursor: number;
  readonly text: Uint8Array;
}

function textEventRequest(event: TextInputEvent): EncodedTextEvent | null {
  let input = 0;
  let flags = 0;
  let anchor = 0;
  let focus = 0;
  let cursor = 0;
  let text: Uint8Array = new Uint8Array(0);
  switch (event.kind) {
    case "insert_text":
      input = INPUT_INSERT_TEXT;
      text = event.text;
      break;
    case "delete_backward":
      input = INPUT_DELETE_BACKWARD;
      break;
    case "delete_forward":
      input = INPUT_DELETE_FORWARD;
      break;
    case "delete_word_backward":
      input = INPUT_DELETE_WORD_BACKWARD;
      break;
    case "delete_word_forward":
      input = INPUT_DELETE_WORD_FORWARD;
      break;
    case "clear":
      input = INPUT_CLEAR;
      break;
    case "move_caret":
      input = INPUT_MOVE_CARET;
      flags = caretFlags(event.move.direction, event.move.extend);
      break;
    case "set_selection":
      input = INPUT_SET_SELECTION;
      anchor = event.selection.anchor;
      focus = event.selection.focus;
      break;
    case "set_composition":
      input = INPUT_SET_COMPOSITION;
      text = event.text;
      cursor = event.cursor ?? event.text.length;
      break;
    case "commit_composition":
      input = INPUT_COMMIT_COMPOSITION;
      break;
    case "cancel_composition":
      input = INPUT_CANCEL_COMPOSITION;
      break;
  }
  if (text.length > EVENT_TEXT_BYTES) return null;
  return { input, flags, anchor, focus, cursor, text };
}

function caretFlags(direction: TextCaretDirection, extend: boolean): number {
  let flags = 0;
  switch (direction) {
    case "previous":
      flags = CARET_PREVIOUS;
      break;
    case "next":
      flags = CARET_NEXT;
      break;
    case "previous_word":
      flags = CARET_PREVIOUS_WORD;
      break;
    case "next_word":
      flags = CARET_NEXT_WORD;
      break;
    case "start":
      flags = CARET_START;
      break;
    case "end":
      flags = CARET_END;
      break;
  }
  return extend ? flags + CARET_EXTEND_FLAG : flags;
}
