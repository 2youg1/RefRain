//! 界面此刻的全部状态。
//!
//! **预算**（PLAN §3 P4）：顶层字段 ≤ 40，禁止 bit-pack。`core.ts` 的 83 个字段
//! 在这里靠三件事收下来，每一件都是删除或归组，没有一件是把字段藏进数字里：
//!
//! 1. **摆渡字段整类消失。** `verdictAccept`/`verdictReject`/`verdictSeed` 是预编好的
//!    请求字节，只因受限子集拼不出 JSON 才存在。Zig 核心自己调
//!    `project_request.zig` 的 42 个编码器，它们没有存在的理由。
//! 2. **成对的量归组。** `windowWidth`+`windowHeight` 是一个尺寸；排版三值是一套
//!    排版；KARA 的五个字段是一台状态机。归组不是为了凑数——一个 `typography`
//!    永远整体读写，拆成三个顶层字段只会让「只改了其中一个」成为可能。
//! 3. **约定换成类型。** `railPeek: number`（0/1）是 bool；`agentDestination: number`
//!    越界即回落是 `?Destination`；`pendingJumpBlock: -1 表示没有` 是 `?u64`；
//!    `rosterCursor: -1` 是 `?u32`。四条要记住的约定变成四个编译器替你记的类型。
//!
//! **答复字节不在这里。** 它们住在 `core/replies.zig` 的模块级存储里，与
//! `host_bridge.zig` 把正稿投影搬进 `projection_text` 是同一条纪律。Model 曾经持过
//! 七个借来的切片（`Replies`），那是两份「最近一条答复是什么」：两份只在同一次
//! `update` 里同步，一次漏改就是画面停在上一条答复上。取消那一组之后顶层
//! 字段是 29 个，且只剩一份权威。
//!
//! **实测 29 个顶层字段。** 我先前判断预算要等单元 11 才能达标（Memo D31），这个
//! 判断错了：归组把十四个正稿量吸成 `document` 与 `viewport` 两个，答复槽则整
//! 组离开了 Model。预算不但达标，还给 12e 的臂留了十一格余量。
//!
//! 规格：`RefRain-work/main+SPEC.md`。

const std = @import("std");
const native_sdk = @import("native_sdk");
const workbench = @import("workbench.zig");
const text = @import("text.zig");

/// 一段界面文字的三档容量。容量写在类型上，旁边写着为什么是这个数。
/// 标识：UUID 是 36 字节，agent id 与提案 id 都比它短。
pub const Id = text.Bounded(64);
/// 路径：Windows 的 MAX_PATH 是 260，跨平台留一倍余量。
pub const Path = text.Bounded(512);
/// 一行话：状态行、提示、查询词、单行草稿。
pub const Line = text.Bounded(256);
/// 一段草稿：改写、派发提示词、批注评论。作者在这里重写一整段话。
pub const Draft = text.Bounded(4096);

/// 排版三值。整体读写——只改其中一个会让断行按旧值算。
/// 缺省与 Rust `TypographyConfig::default`（config.rs）同源。
pub const Typography = struct {
    /// 正文字号（px）。
    text_size: f64 = 17,
    /// 行高（字号百分比）。
    line_height_percent: u32 = 190,
    /// 作者选的行长（字身）。它是**上限不是定值**：实际断行取它与视口实测的较小者。
    measure_em: f64 = 65,
};

/// KARA 六态机在界面上的投影。机器在 Rust（INV-10），这里只落地答复里读到的名字。
pub const Kara = struct {
    /// 0 off / 1 entering / 2 writing / 3 reviewing / 4 away / 5 leaving，
    /// 与 kara.rs 的声明序一致。
    state: u8 = 0,
    /// 安静事件的队列掩码：1 已保存 / 2 agent 完成 / 4 提案到达 / 8 索引刷新。
    /// 队列住在 Rust 的机器里，每次答复把它的内容搬过来。
    queued: u8 = 0,
    /// 回来卡开着（「你停在这里：…」），600ms 自消。
    card: bool = false,
    /// 回来卡的前文（`ReturnPoint.sentenceTail`）。
    return_tail: Line = .empty,
    /// 打断码（`interruptNow` 的线名，空 = 没有打断），4s 自消。中文措辞表在绘制侧。
    interrupt: Line = .empty,
};

/// 裁决台的全部状态。
pub const Review = struct {
    /// 在看自己的改法(false)还是竞争稿(true)。竞争 = 同一份名录里 scope 相同的两条；
    /// 查找归绘制侧（它有完整名录），这里只记翻到哪面。移动游标与刷新都会归位。
    peer: bool = false,
    /// 就地裁决饭盒开着的提案 id（空 = 关着）。
    proposal: Id = .empty,
    /// 已记下、随下一次裁决发出的理由。**空串也是一条记下的理由**——所以「有没有
    /// 理由」由 `reason_recorded` 说，不由长度说。判后即清：理由只骑一次裁决。
    reason: Draft = .empty,
    reason_recorded: bool = false,
    /// 理由框开着。开着时 Escape 先关框，不误退面板。
    reason_open: bool = false,
    reason_draft: Draft = .empty,
    /// 过期提案的冻结原文（Agent 当时读到的字），空 = 没有过期面板。
    stale_frozen: Draft = .empty,
    /// 过期提案的恢复步骤码（kebab 串，\n 连接），绘制侧按翻译表出中文。
    stale_recovery: Line = .empty,
    /// 裁决批次里暂存了几条。提交按钮与 Alt+Enter 的门：0 时不发提交。
    staged_count: u32 = 0,
    /// 判后自动前进的挂起旗：答复落地时转成一次 120ms 的延迟前进。
    /// 答复才挂延迟而不是按键就挂——判失败的裁决不该移动作者的注意力。
    advance_armed: bool = false,
};

/// 派发台的全部状态。
pub const Dispatch = struct {
    prompt: Draft = .empty,
    /// 改派几个 agent。并列的 Run 读同一份请求，各写各的产出。
    agents: u32 = 1,
    /// 排法下标（三种循环）。名字在绘制侧，与去处表同一条纪律。
    orchestration: u8 = 0,
    /// 带稿模式：0=增量 1=全文 2=不带。
    carry: u8 = 0,
    /// 选中的 agent（空 = 手动往返）。
    agent: Id = .empty,
    /// 勾选的块序号位图。有界数组而不是位压缩的数字——与面板栈同一条裁定。
    checked: std.StaticBitSet(1024) = std.StaticBitSet(1024).initEmpty(),
    /// 攒进发送的段落（正文右键，只记录不打断写作）。
    stash: Draft = .empty,
    /// 块清单的下一页游标；null = 没有下一页。
    blocks_next: ?u32 = null,
    /// 随这次派发带上的材料路径，换行分隔。路径里不会有换行，所以分隔符
    /// 不会与内容撞车——与攻进发送的段落用 NUL 是同一条理由的两个答案（正文
    /// 含换行，不含 NUL）。
    materials: Draft = .empty,
};

/// 正在编辑的一份草稿：改写、材料、agent argv 共用这一个形状。
pub const Editing = struct {
    id: Id = .empty,
    body: Draft = .empty,

    pub fn isOpen(self: *const Editing) bool {
        return !self.id.isEmpty();
    }
};

/// 打开的那份稿子:它是谁,以及存没存过。
///
/// 九个量归一组是因为它们**永远一起读**:状态行要同时说出字数、修订号与「有未保存
/// 的改动」,而后者是 `revision != saved_revision`。拆成九个顶层字段会让「只更新了
/// 其中一个」成为可能——一次答复落地漏掉 `saved_revision`,界面就会永远说脏。
pub const Document = struct {
    /// 0 = 没有打开的稿子。
    session: u64 = 0,
    revision: u64 = 0,
    bytes: u64 = 0,
    blocks: u64 = 0,
    /// 保存请求在飞。「已保存」必须有正面证据,不能靠「上一次请求是保存」猜。
    save_pending: bool = false,
    saved_revision: u64 = 0,
    path: Path = .empty,
    cursor: Id = .empty,
    total: u32 = 0,
};

/// 正稿视口:窗口开在稿子的哪一段上。
///
/// 五个量归一组是因为滚动锚定同时读它们(M13 的两半就是在这里对上的):首块、
/// 窗口起点与像素偏移必须描述同一个位置,分开更新会让轨道刻度与投影错位。
pub const Viewport = struct {
    scroll: f64 = 0,
    first_block: u64 = 0,
    window_start: u64 = 0,
    /// 当前生效的行长(字身):绘制侧按它换算编辑区宽度,两处不各算一遍。
    columns_em: f64 = 0,
    /// 正文视口的像素高。0 表示帧还没到过。
    height_px: u32 = 0,
};

/// 命令面板。它不是第九个去处:关掉它作者回到原处。
pub const Palette = struct {
    open: bool = false,
    /// 打开时清空——每次打开都是一次新的「我要去…」,上次的一半查询会让作者
    /// 以为面板没刷新。
    query: Line = .empty,
};

/// 搜索框的状态。
pub const Search = struct {
    query: Line = .empty,
    /// 精确还是宽松。它是作者的选择，不是一个藏起来的默认。
    exact: bool = false,
};

/// 界面此刻的全部状态。顶层 29 个字段。
pub const Model = struct {
    // ---- 与 Rust 的握手 ----------------------------------------------- 2
    host_ready: bool = false,
    status: Line = .empty,

    // ---- 正稿 ---------------------------------------------------------- 2
    document: Document = .{},
    viewport: Viewport = .{},

    // ---- 窗口与外观 ---------------------------------------------------- 4
    /// 最近一帧的窗口像素尺寸。0 表示帧还没到过。
    window: native_sdk.geometry.SizeF = native_sdk.geometry.SizeF.init(0, 0),
    /// 指向生成的色表。Model 只记「选了第几套」，不持有任何颜色。
    theme_index: u8 = 0,
    /// 0 实心 / 1 亚克力 / 2 液态玻璃。语义归 `material.zig` 的配方表。
    panel_material: u8 = 0,
    typography: Typography = .{},

    // ---- 去处与面板 ---------------------------------------------------- 7
    /// 首启落**文件**去处而不是稿子：功能区首帧即开，作者第一眼就看到全部入口
    /// ——文件树、「前往」节、打开项目按钮。稿子去处没有侧栏，从它起步等于把功能
    /// 全藏起来（v0.3.0 走查问题 1）。
    destination: workbench.Destination = .files,
    panel_stack: workbench.PanelStack = .empty,
    /// Agent 区（Cmd+4）记住的上次去处。null = 还没记过，回落派发。
    agent_destination: ?workbench.Destination = null,
    /// 功能区是鼠标贴左缘探出来的，此后还没有任何交互。任何交互解除它：
    /// 栏留下，解除的只是「自动收回」的资格。
    rail_peek: bool = false,
    /// 侧栏占分栏的比例（作者拖出来的）。
    rail_fraction: f64 = workbench.rail_fraction_default,
    /// 分栏投影：`layoutFraction` 算出，绘制侧只读这一个值，不抄第二张表。
    layout_fraction: f64 = 1.0,
    root_id: Id = .empty,

    // ---- 浮层与提示 ---------------------------------------------------- 2
    palette: Palette = .{},
    /// 最近一次被拒绝的导航要告诉作者的话。null = 无事——空串与「没有话说」
    /// 在 TS 侧要靠第二个布尔区分,可选类型让那个字段没有必要。
    notice: ?Line = null,

    // ---- 名录 ---------------------------------------------------------- 2
    /// 游标指向一个存在的行，或者 null。不变量归 `roster.zig`。
    roster_cursor: ?u32 = null,
    roster_count: u32 = 0,

    // ---- 各台的状态 ---------------------------------------------------- 6
    search: Search = .{},
    review: Review = .{},
    dispatch: Dispatch = .{},
    /// 正在改写的提案。
    revising: Editing = .{},
    /// 正在编辑的材料草稿。
    material_draft: Editing = .{},
    /// 正在编辑 argv 的 agent。起笔是空——快照是借用模式，拼不出现有 argv。
    editing_agent: Editing = .{},

    // ---- 其余 ---------------------------------------------------------- 3
    annotation_draft: Draft = .empty,
    mailbox_discarded: bool = false,
    /// 跨文档跳块的挂起块序号。搜索命中另一份文档时，开文档与跳块是两次请求——
    /// 打开答复落地后由它补发跳块投影。
    pending_jump_block: ?u64 = null,
    kara: Kara = .{},

    /// 有没有一份打开的稿子。导航的每一次拒绝都问它。
    pub fn hasDocument(self: *const Model) bool {
        return self.document.session != 0;
    }

    /// 有未保存的改动吗。两个数字的差,不是一个自己会漂的旗。
    pub fn isDirty(self: *const Model) bool {
        return self.document.revision != self.document.saved_revision;
    }
};

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "顶层字段守住 40 的预算" {
    // PLAN §3 P4 的预算。这条测试是那句话的执行形式——加第 41 个字段要么先删一个，
    // 要么先改纲领。
    const fields = @typeInfo(Model).@"struct".fields.len;
    try testing.expect(fields <= 40);
}

test "四条要记住的约定变成了类型" {
    const model: Model = .{};
    // TS 的 rosterCursor = -1、pendingJumpBlock = -1、agentDestination 越界回落，
    // 三条都是读者要记住的约定；这里编译器替你记。
    try testing.expectEqual(@as(?u32, null), model.roster_cursor);
    try testing.expectEqual(@as(?u64, null), model.pending_jump_block);
    try testing.expectEqual(@as(?workbench.Destination, null), model.agent_destination);
    // railPeek 是 0/1 的数字，这里是 bool。
    try testing.expectEqual(false, model.rail_peek);
}

test "归组的每一组都是永远一起读的量" {
    // 归组不是为了凑预算:保存的证据要同时读 revision 与 saved_revision,滚动锚定
    // 要同时读首块与窗口起点。拆开会让「只更新了其中一个」成为可能。
    try testing.expectEqual(@as(usize, 9), @typeInfo(Document).@"struct".fields.len);
    try testing.expectEqual(@as(usize, 5), @typeInfo(Viewport).@"struct".fields.len);
}

test "缺省的模型是一个诚实的空界面" {
    const model: Model = .{};
    try testing.expect(!model.hasDocument());
    try testing.expect(!model.isDirty());
    // 首启在文件去处：空界面要把入口摆出来，不是摆一张白纸。
    try testing.expectEqual(workbench.Destination.files, model.destination);
    try testing.expectEqual(@as(u8, 0), model.panel_stack.depth);
    // 排版缺省与 Rust 的 TypographyConfig::default 同源。
    try testing.expectEqual(@as(f64, 17), model.typography.text_size);
    try testing.expectEqual(@as(u32, 190), model.typography.line_height_percent);
}

test "保存的证据是两个数字的差，不是一面自己会漂的旗" {
    var model: Model = .{ .document = .{ .session = 1 } };
    try testing.expect(model.hasDocument());
    model.document.revision = 5;
    try testing.expect(model.isDirty());
    model.document.saved_revision = 5;
    try testing.expect(!model.isDirty());
}

test "摆渡字段没有回来" {
    // 这条钉住的是一个删除：`Review` 若哪天长出 accept/reject 两串预编字节，
    // 就是 TS 车道的伤疤又回来了。
    inline for (@typeInfo(Review).@"struct".fields) |field| {
        try testing.expect(!std.mem.eql(u8, field.name, "accept"));
        try testing.expect(!std.mem.eql(u8, field.name, "reject"));
        try testing.expect(!std.mem.eql(u8, field.name, "seed"));
    }
}
