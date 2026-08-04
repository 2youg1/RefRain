import { asciiBytes, Cmd } from "@native-sdk/core";
import type { ScrollState } from "@native-sdk/core/events";
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
  INPUT_SAVE,
  INPUT_SET_COMPOSITION,
  INPUT_SET_SELECTION,
  INPUT_UNDO,
  isDispatchResponse,
  PROTOCOL_VERSION,
} from "./generated/protocol.ts";
import { afterRefresh, hasRow, NO_ROW, step } from "./roster.ts";
import {
  DESTINATION_MANUSCRIPT,
  destinationAt,
  destinationForOrdinal,
  NAVIGATION_MOVED,
  NAVIGATION_NEEDS_DOCUMENT,
  navigate,
  settleAfterDocument,
} from "./workbench.ts";

/**
 * 字身 per line for the manuscript column.
 *
 * Sent with every document request so Rust can return 禁则-correct break
 * offsets — the SDK only breaks at space and tab, which no Chinese paragraph
 * contains. Fixed for now; step 6 derives it from the measured viewport width
 * and the reader's chosen 行长.
 */
const DOCUMENT_COLUMNS_EM = 40;

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

export interface Model {
  readonly hostReady: boolean;
  readonly status: Uint8Array;
  readonly protocolVersion: number;
  readonly documentSession: number;
  readonly documentRevision: number;
  readonly documentBytes: number;
  readonly documentBlocks: number;
  readonly documentScroll: number;
  readonly viewportFirstBlock: number;
  readonly projectionWindowStart: number;
  readonly projectResult: Uint8Array;
  /**
   * 当前主题的下标，指向 `generated/themes.zig` 的 `themes` 表。
   *
   * 界面状态归 Model（Roadmap 2.3 的结构限制），色值归生成的色表——Model 只
   * 记「选了第几套」，不持有任何颜色。切换主题因此是一次 Msg，不是一次样式写入。
   */
  readonly themeIndex: number;
  /**
   * 作者此刻在哪个去处，指向 `workbench.ts` 的 `DESTINATIONS`。
   *
   * 与 `themeIndex` 同一条纪律：Model 记下标，名字与规则归表。八个去处不写成
   * 八个布尔值——两个布尔可以同时为真，一个下标不可能同时是两个值。
   */
  readonly destinationIndex: number;
  /**
   * 命令面板是否张着。它不是第九个去处：命令面板浮在当前去处之上，
   * 关掉它作者回到原处，而不是回到某个默认去处。
   */
  readonly paletteOpen: boolean;
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
   * 文件树这一页的行数，与名录的 `rosterCount` 分开。
   *
   * 两个计数不合成一个：作者可以一边在文件树里翻页，一边在裁决台上停在
   * 某一行。合成一个的表现是换去处时文件树的位置被名录冲掉。
   */
  readonly documentCount: number;
  /**
   * 项目里一共有多少份文档，包括没装进这一页的。
   *
   * 与 `documentCount` 分开是同一条纪律：界面数得到的是「装得下的那些」，
   * 而作者读成的是「一共这么多」。截断因此是可见事实，不是静默损失。
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
  | { readonly kind: "document_input"; readonly event: TextInputEvent }
  | { readonly kind: "document_scroll"; readonly scroll: ScrollState }
  | { readonly kind: "document_undo" }
  | { readonly kind: "document_save" }
  | { readonly kind: "project_request"; readonly input: Uint8Array }
  /** Open one document of an adopted Root. `reference` is `rootId\npath`. */
  | { readonly kind: "document_open"; readonly reference: Uint8Array }
  /** 选一套主题。`index` 指向生成色表；越界回落到默认。 */
  | { readonly kind: "theme_select"; readonly index: number }
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
  /** 按数字键直达。平台传键位序号（Cmd+1 是 1），下标换算归 `workbench.ts`。 */
  | { readonly kind: "workbench_key"; readonly ordinal: number }
  /** 开合命令面板。它浮在当前去处之上，不改变去处本身。 */
  | { readonly kind: "palette_toggle" }
  /** 作者读过了那条拒绝提示。 */
  | { readonly kind: "notice_dismiss" }
  /**
   * 在当前去处的名录里上下移动。裁决、派发、信箱、连接共用这一条。
   *
   * 一条消息而不是四条：四个去处的「下一行」是同一件事，分成四条会让
   * 键盘绑定也分成四份，而它们必然写成同样的内容。
   */
  | { readonly kind: "roster_step"; readonly delta: number }
  /**
   * Rust 答复里的事实落进 Model。Zig 读完那段 JSON 后送这一条。
   *
   * **为什么由 Zig 送而不是 core 自己解**：core 子集没有 JSON 解析器，
   * 而答复是一段不透明字节。读法住在 `snapshot.zig`（可单测），这一条只
   * 负责落地——两边都不必知道对方的内部结构。
   *
   * `rootId` 为空表示这次答复没有带 Root（例如设置或 KARA），此时保留
   * 当前的那一个：一次读设置不该让作者的项目从界面上消失。
   */
  | {
      readonly kind: "project_facts";
      readonly rootId: Uint8Array;
      readonly documentCursor: Uint8Array;
      readonly documentCount: number;
      readonly documentTotal: number;
      readonly rosterCount: number;
    }
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
  /** 改派几个 agent。并列的 Run 读同一份请求，各写各的产出。 */
  | { readonly kind: "dispatch_agents"; readonly delta: number }
  /** 换一种排法。三种循环，与去处表同一条纪律：下标在 Model，名字在 Zig。 */
  | { readonly kind: "dispatch_orchestration" }
  /** 换一档搜索精度。精确与宽松是作者的选择，不是一个藏起来的默认。 */
  | { readonly kind: "search_precision" };

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
    case "roster.next":
      return { kind: "roster_step", delta: 1 };
    case "roster.previous":
      return { kind: "roster_step", delta: -1 };
    case "document.save":
      return { kind: "document_save" };
    case "document.undo":
      return { kind: "document_undo" };
    case "theme.next":
      return { kind: "theme_next" };
    case "app.quit":
      return { kind: "app_quit" };
    default:
      return null;
  }
}

export const viewUnbound = [
  "documentSession",
  "documentScroll",
  "viewportFirstBlock",
  "projectionWindowStart",
  "projectResult",
  "dispatch_ok",
  "dispatch_err",
  "document_input",
  "document_scroll",
  "project_request",
  "document_open",
  // 工具栏只有「换下一套」一个按钮；按下标直选留给设置面板与真像素验收，
  // 目前没有标记绑定它。
  "theme_select",
  // 退出只从系统菜单与 ⌘Q/Ctrl+Q 发出，标记里没有按钮绑它——正稿界面上
  // 放一个「退出」按钮会挤占写作空间，而两个入口已覆盖三平台的惯例。
  "app_quit",
  // 主题下标由 Zig 的 `manuscriptTokens` 读去查色表，标记不直接绑它——
  // 界面看到的是颜色，不是下标。
  "themeIndex",
  // 命令面板由 Zig 的 `commandPalette` 画：八个去处的名字是中文，进不了
  // core 子集的 rodata（NS9001），所以开合标志与那条消息都只走 Zig。
  "paletteOpen",
  "workbench_go",
  // 键位序号由平台事件层翻译后送进来；标记里没有键盘绑定语法。
  "workbench_key",
  "destinationIndex",
  // 名录由 Zig 的 `rosterView` 画：行文字来自 Rust 快照，中文表头住在 Zig。
  // 计数与游标只喂那一段，标记里没有绑定它们的元素。
  "rosterCount",
  "rosterCursor",
  // 上下移动由平台键盘事件送进来，与 `workbench_key` 同一条路径。
  "roster_step",
  // 这五个由 Zig 视图消费：文件树与名录的行文字来自 Rust 答复，读法住在
  // `snapshot.zig`。标记里没有绑定它们的元素——界面看到的是一列行，
  // 不是一个 id 或一个计数。
  "rootId",
  "documentCursor",
  "documentCount",
  "documentTotal",
  "project_facts",
  // 搜索框的字由 Zig 的输入部件送进来；精度键也在 Zig 侧（中文标签）。
  "searchQuery",
  "searchExact",
  "search_typed",
  "search_precision",
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
  "dispatchOrchestration",
  "dispatch_orchestration",
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
    documentScroll: 0,
    viewportFirstBlock: 0,
    projectionWindowStart: 0,
    projectResult: new Uint8Array(0),
    themeIndex: DEFAULT_THEME_INDEX,
    destinationIndex: DESTINATION_MANUSCRIPT,
    paletteOpen: false,
    notice: new Uint8Array(0),
    noticeShown: false,
    rosterCount: 0,
    rosterCursor: NO_ROW,
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
    // 默认一个 agent：并列是作者主动选的，不是一个藏起来的默认。
    dispatchAgents: 1,
    // 默认并列：它是唯一不给 Run 之间强加顺序的排法，也是多数时候要的。
    dispatchOrchestration: 0,
  };
}

export function initialModel(): [Model, Cmd<Msg>] {
  const model = checkingModel();
  return [
    model,
    Cmd.request(
      /* @generated:host-service */ "refrain.host",
      {
        action: ACTION_HEALTH,
        anchor: 0,
        columnsEm: DOCUMENT_COLUMNS_EM,
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
      },
      { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
    ),
  ];
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "dispatch_ok": {
      const bytes = msg.bytes;
      if (!isDispatchResponse(bytes) || dispatchResponseStatus(bytes) !== 0) {
        return {
          ...model,
          hostReady: false,
          status: asciiBytes("Native host returned an invalid contract."),
        };
      }
      const action = dispatchResponseAction(bytes);
      if (action === ACTION_HEALTH) {
        if (
          dispatchResponseApiVersion(bytes) !== API_VERSION ||
          (dispatchResponseCapabilities(bytes) & CAPABILITY_MASK) !== CAPABILITY_MASK
        ) {
          return {
            ...model,
            hostReady: false,
            status: asciiBytes("Native host capability mismatch."),
          };
        }
        const ready: Model = {
          ...model,
          hostReady: true,
          status: asciiBytes("Opening the Rust manuscript projection..."),
          protocolVersion: PROTOCOL_VERSION,
        };
        return [
          ready,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            {
              action: ACTION_OPEN_MANUSCRIPT,
              anchor: 0,
              columnsEm: DOCUMENT_COLUMNS_EM,
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: ready.documentRevision,
              scrollOffsetY: ready.documentScroll,
              session: ready.documentSession,
              text: new Uint8Array(0),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: ready.viewportFirstBlock,
              windowStart: ready.projectionWindowStart,
            },
            { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
          ),
        ];
      }
      if (action === ACTION_PROJECT) {
        // 编排快照与设置、项目共用这一条返回路径。名录的行数由 Zig 侧解
        // 快照得到——core 子集没有 JSON，而这正好把「快照长什么样」留在
        // 一个地方。这里只把游标钳进新长度：`afterRefresh` 让作者连着处理
        // 三封信不必每次重新找位置。
        const text = dispatchResponseText(bytes);
        return {
          ...model,
          hostReady: true,
          status: asciiBytes("Rust project use case completed."),
          projectResult: text,
        };
      }
      if (
        action !== ACTION_OPEN_MANUSCRIPT &&
        action !== ACTION_APPLY_INPUT &&
        action !== ACTION_OBTAIN_PROJECTION
      ) {
        return { ...model, status: asciiBytes("Native host returned an unknown dispatch action.") };
      }
      return {
        ...model,
        hostReady: true,
        status: asciiBytes("100,000 blocks · viewport projection · Rust document authority"),
        documentSession: dispatchResponseSession(bytes),
        documentRevision: dispatchResponseRevision(bytes),
        documentBytes: dispatchResponseTotalBytes(bytes),
        documentBlocks: dispatchResponseTotalBlocks(bytes),
        viewportFirstBlock: dispatchResponseFirstBlock(bytes),
        projectionWindowStart: dispatchResponseWindowStart(bytes),
        // 稿子换了或没了，读稿子的去处就站不住了。让 `settleAfterDocument`
        // 判——它与 `needsDocument` 同源，新增去处时这里不必跟着改。
        destinationIndex: settleAfterDocument(
          model.destinationIndex,
          dispatchResponseSession(bytes) !== 0,
        ),
      };
    }
    case "dispatch_err":
      return rejectDispatch(model, msg.bytes);
    case "document_input": {
      if (model.documentSession === 0) return model;
      const event = textEventRequest(msg.event);
      if (event === null) {
        return { ...model, status: asciiBytes("The text event exceeded the fixed ABI bound.") };
      }
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_APPLY_INPUT,
            anchor: event.anchor,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_scroll": {
      const scrolled: Model = { ...model, documentScroll: msg.scroll.offsetY };
      if (model.documentSession === 0 || msg.scroll.offsetY === model.documentScroll) {
        return scrolled;
      }
      return [
        scrolled,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_OBTAIN_PROJECTION,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_undo": {
      if (model.documentSession === 0) return model;
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_APPLY_INPUT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "document_save": {
      if (model.documentSession === 0) return model;
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_APPLY_INPUT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
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
        return { ...model, status: asciiBytes("The document reference exceeded the ABI bound.") };
      }
      // 记住打开的是哪一份：裁决与提案读取都以它为作用域。引用的形状是
      // `rootId\npath`，所以路径是换行之后那一段。
      let split = 0;
      while (split < msg.reference.length && msg.reference[split] !== 10) split = split + 1;
      const opening: Model = {
        ...model,
        status: asciiBytes("Opening the chosen document..."),
        documentPath: msg.reference.slice(split + 1),
      };
      return [
        opening,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_OPEN_MANUSCRIPT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
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
      const index = (model.themeIndex + 1) % THEME_COUNT;
      return [
        { ...model, themeIndex: index },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
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
        Number.isInteger(msg.index) && msg.index >= 0 && msg.index < THEME_COUNT
          ? msg.index
          : DEFAULT_THEME_INDEX;
      return [
        { ...model, themeIndex: index },
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
          { key: "native-dispatch", ok: "dispatch_ok", err: "dispatch_err" },
        ),
      ];
    }
    case "workbench_go":
      return goTo(model, destinationAt(msg.index));
    case "workbench_key": {
      const target = destinationForOrdinal(msg.ordinal);
      // 不是导航键就原样返回：这条消息也承担「这个键归不归我管」的判断，
      // 免得每个调用点自己先查一遍表。
      return target < 0 ? model : goTo(model, target);
    }
    case "palette_toggle":
      // 开合面板不动去处，也不清提示：作者可能正是因为看到拒绝才打开面板。
      return { ...model, paletteOpen: !model.paletteOpen };
    case "notice_dismiss":
      return model.noticeShown
        ? { ...model, notice: new Uint8Array(0), noticeShown: false }
        : model;
    case "roster_step": {
      // 不变量归 `roster.ts`：这里只落地，不自己判越界。四个去处共用它，
      // 所以「撞到底就停」这条规矩只有一份。`hasRow` 与游标一起写——
      // 两处漂开的表现是一个指着空名录却仍可点的按钮。
      const moved = step(model.rosterCursor, msg.delta, model.rosterCount);
      return { ...model, rosterCursor: moved, rosterHasRow: hasRow(moved, model.rosterCount) };
    }
    case "project_facts": {
      // 落地 Zig 读出的事实。空 `rootId` 表示这次答复没有带 Root（读设置、
      // 推进 KARA），保留当前那一个——一次读设置不该让项目从界面上消失。
      const rootId = msg.rootId.length > 0 ? msg.rootId : model.rootId;
      const settled = afterRefresh(model.rosterCursor, msg.rosterCount);
      // 名录变短是这类界面最常见的一次改动（收走一个 Run、弃置一封信），
      // 而它正是「游标指向已消失的行」的来源。不变量归 `roster.ts`：
      // `afterRefresh` 让作者连着处理三封信不必每次重新找位置。
      return {
        ...model,
        rootId: rootId,
        documentCursor: msg.documentCursor,
        documentCount: msg.documentCount,
        documentTotal: msg.documentTotal,
        rosterCount: msg.rosterCount,
        rosterCursor: settled,
        rosterHasRow: hasRow(settled, msg.rosterCount),
      };
    }
    case "search_typed":
      // 只承载字节。查询词的分词、召回与排序都在 Rust——界面在这里做一次
      // 「太短就不搜」之类的判断，就会与 Rust 的规则各说各话。
      return { ...model, searchQuery: searchAfterEdit(model.searchQuery, msg.event) };
    case "search_precision":
      return { ...model, searchExact: !model.searchExact };
    case "revision_begin":
      // 起点是 Agent 建议的改后文字，由调用方从 Rust 答复里读出来传进来。
      // 换一条提案改写会丢掉上一条改到一半的文字——这是对的：那段文字是
      // 针对上一条提案的，留着它会让作者把 A 的改写提交到 B 上。
      return {
        ...model,
        revisingProposal: msg.proposalId,
        revisionText: msg.seed,
      };
    case "revision_typed":
      // 没在改写时忽略输入。少了这条守卫，一次落错地方的按键会凭空开始
      // 一段没有归属的改写，而它提交时才会被 Rust 拒绝。
      if (model.revisingProposal.length === 0) return model;
      return { ...model, revisionText: draftAfterEdit(model.revisionText, msg.event) };
    case "dispatch_typed":
      return { ...model, dispatchPrompt: draftAfterEdit(model.dispatchPrompt, msg.event) };
    case "dispatch_agents": {
      // 钳在 1..4。零个 agent 的派发铸不出 Run，作者看到的是一行永远
      // 等待的 Task；上限是因为并列的 Run 各跑一个真实进程。
      const next = model.dispatchAgents + msg.delta;
      return { ...model, dispatchAgents: next < 1 ? 1 : next > 4 ? 4 : next };
    }
    case "dispatch_orchestration":
      // 三种循环。越界回落到并列——一个下标指不到的排法会让 Rust 那边
      // 具名拒绝，而作者只是多按了一下。
      return { ...model, dispatchOrchestration: (model.dispatchOrchestration + 1) % 3 };
    case "revision_cancel":
      // 两个字段一起清。只清 id 会留下一段孤立的文字，下次改写时它会作为
      // 起点冒出来，作者读成的是「上一条的字漏进来了」。
      return {
        ...model,
        revisingProposal: new Uint8Array(0),
        revisionText: new Uint8Array(0),
      };
    case "project_request": {
      if (msg.input.length > EVENT_TEXT_BYTES) {
        return { ...model, status: asciiBytes("The project input exceeded the fixed ABI bound.") };
      }
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: ACTION_PROJECT,
            anchor: 0,
            columnsEm: DOCUMENT_COLUMNS_EM,
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
          },
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
function goTo(model: Model, target: number): Model {
  const result = navigate(model.destinationIndex, target, model.documentSession !== 0);
  if (result === NAVIGATION_MOVED) {
    // 到了新去处就清掉上一条拒绝提示，并收起命令面板——面板的用途是选一个
    // 去处，选完它就该让开。
    // 名录也一起清空：新去处的名录还没读，留着上一处的计数会让界面显示
    // 一列并不存在的行，而游标停在其中一行上。计数由 `project_facts` 填。
    return {
      ...model,
      destinationIndex: destinationAt(target),
      paletteOpen: false,
      notice: new Uint8Array(0),
      noticeShown: false,
      rosterCount: 0,
      rosterCursor: NO_ROW,
      rosterHasRow: false,
    };
  }
  if (result === NAVIGATION_NEEDS_DOCUMENT) {
    // 拒绝要留下痕迹：默默不动会让作者以为快捷键坏了。去处名不进这条消息
    // ——它是中文，而 core 子集不允许非 ASCII 进 rodata。
    return { ...model, notice: asciiBytes("Open a manuscript first."), noticeShown: true };
  }
  return model.paletteOpen ? { ...model, paletteOpen: false } : model;
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
    return { ...model, status: asciiBytes("Rust refused the document input.") };
  }
  if (code === ERROR_HOST_FAILURE) {
    return { ...model, status: asciiBytes("Native Rust host failed.") };
  }
  if (code === ERROR_STALE_REVISION) {
    return {
      ...model,
      documentRevision: dispatchResponseRevision(bytes),
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
