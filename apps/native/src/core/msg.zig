//! 一件发生过的事。
//!
//! **与 `core.ts` 的 `Msg` 的两处收窄**，都不是改写而是删除：
//!
//! 1. **四个答复臂并成一个。** TS 侧有 `dispatch_ok`/`dispatch_err`/`save_ok`/
//!    `save_err`，因为 `Cmd.request` 给每个通道各配一对 ok/err 标签。Zig 侧
//!    `fx.hostRequest` 的 `on_result` 是一个无捕获的函数指针，答复带着 `key` 回来，
//!    而 `replay_seam.Channel.fromKey` 认得那个 key——于是**一个 `host_result` 臂**
//!    同时承载两个通道的成败四种情形，路由由类型给出而不是由四个臂名给出。
//! 2. **预编请求整类消失。** TS 的 `verdict_begin` 要捎上 `accept` 与 `reject` 两串
//!    已经编好的请求字节，因为受限子集拼不出 JSON，只能让 Zig 在开盒时先编好。
//!    Zig 核心自己就能调 `project_request.zig` 的 42 个编码器，所以这两个字段没有
//!    存在的理由——`verdictAccept`/`verdictReject`/`verdictSeed` 这一族摆渡字段随之
//!    从 `Model` 里一并消失（PLAN §3 P4「seam-ferry 形态整类消失」）。
//!
//! 第三处是定时器：TS 的延迟臂捎一个自己编的 `at: number`；Zig 的定时器答复是
//! `EffectTimer`，带着平台的触发时刻**与**「这次是真的烧到了还是被拒绝了」。
//! 被拒绝的定时器在 TS 车道上不可区分于没挂上。
//!
//! 规格：`RefRain-work/main+SPEC.md`。

const std = @import("std");
const native_sdk = @import("native_sdk");
const workbench = @import("workbench.zig");

const canvas = native_sdk.canvas;

/// 一次改写、材料草稿或裁决的起笔：由绘制侧从名录里读出来交过来。
///
/// 起点是 Agent 建议的改后文字而不是空白——作者多数时候只改一两个词。
pub const Seeded = struct {
    id: []const u8,
    seed: []const u8,
};

pub const Msg = union(enum) {
    // ---------------------------------------------------------- Rust 的答复
    /// Rust 答复了。哪个通道由 `replay_seam.Channel.fromKey(result.key)` 认，
    /// 成败由 `result.ok` 说——四个 TS 臂在这里是一个。
    host_result: native_sdk.EffectHostResult,

    // ------------------------------------------------------------ 正稿
    document_input: canvas.TextInputEvent,
    document_scroll: canvas.ScrollState,
    document_save,
    document_undo,
    /// 跳到搜索命中的那一块。块序号由绘制侧从命中行读出。
    document_jump: u64,
    /// 回到历史面板选中的那一条动作。
    document_revert: []const u8,
    /// 打开一份文档。`reference` 是 `rootId\npath`。
    document_open: []const u8,
    /// 打开另一份文档并跳到命中的那一块：打开之前没有会话，跳块无处着落，
    /// 所以块序号跟着打开一起过来，由打开的答复落地后补发。
    document_open_jump: struct { reference: []const u8, block: u64 },

    /// 一帧的真实窗口像素尺寸。尺寸没变就不该送这一条。
    frame: native_sdk.geometry.SizeF,

    // ------------------------------------------------------------ 去处与面板
    /// 去某个去处。类型是枚举，所以「越界的去处」不可表示。
    workbench_go: workbench.Destination,
    /// 按数字键直达。收的是键位序号（Cmd+1 是 1），换算归 `workbench.zig`。
    workbench_key: u8,
    /// 贴左缘悬停：稿子全宽时左缘 4px 探头条开出功能区。
    rail_peek_open,
    /// 指针移出探头栏的整个栏宽：栏没被动过就收回稿子。
    rail_peek_close,
    /// 面板退一层（Escape / Ctrl+[）。
    panel_back,
    /// 侧栏分隔条被拖动。
    split_resize: f64,
    palette_toggle,
    palette_query: canvas.TextInputEvent,
    notice_dismiss,
    /// 无事发生。排版滑杆没跨过一个步距时送它——诚实的落地就是不动，
    /// 不该为它编一条空请求让 Rust 白写一次盘。
    noop,
    app_quit,

    // ------------------------------------------------------------ 外观
    theme_select: u8,
    theme_next,
    material_select: u8,

    // ------------------------------------------------------------ 名录
    /// 在当前去处的名录里上下移动。裁决、派发、信箱、连接共用这一条——
    /// 四个去处的「下一行」是同一件事，分成四条会让键盘绑定也分成四份。
    roster_step: i32,

    // ------------------------------------------------------------ 搜索
    search_typed: canvas.TextInputEvent,
    search_precision,
    /// 即打即搜的防抖到点。
    search_fire: native_sdk.EffectTimer,

    // ------------------------------------------------------------ 裁决台
    /// 开始改写一条提案。
    revision_begin: Seeded,
    revision_typed: canvas.TextInputEvent,
    revision_cancel,
    /// 打开就地裁决饭盒。只带提案 id 与改写起笔——接受与退回的请求由本核心
    /// 在按下时现编（TS 侧必须预编，因为它拼不出 JSON）。
    verdict_begin: Seeded,
    verdict_accept,
    verdict_reject,
    verdict_revise,
    verdict_close,
    /// 翻开/翻回竞争稿（Alt+P）。
    review_peer,
    review_reason_open,
    review_reason_typed: canvas.TextInputEvent,
    /// 记下理由（空串也是一条记下的理由）。
    review_reason_commit,
    review_reason_cancel,
    /// 落定（Alt+Enter）：改写中就把改写落成裁决，否则提交暂存的批次。
    verdict_settle,
    /// 裁决台的裁决按钮。
    desk_verdict: []const u8,
    /// 判后自动前进：答复落地时挂出的一次延迟，只把游标 +1。
    review_advance: native_sdk.EffectTimer,
    stale_dismiss,

    // ------------------------------------------------------------ 派发台
    dispatch_typed: canvas.TextInputEvent,
    dispatch_agents: i32,
    dispatch_orchestration,
    dispatch_block_toggle: u32,
    dispatch_blocks_all,
    dispatch_blocks_clear,
    dispatch_carry: u8,
    /// 选中一个 agent；空 id = 手动往返。
    dispatch_agent: []const u8,
    dispatch_material_toggle: []const u8,
    /// 攒进发送：把这段选区原文攒起来（只记录，不打断写作）。
    dispatch_stash: []const u8,
    dispatch_stash_drop: u32,
    dispatch_stash_clear,
    /// Run 名录的轮询一跳：只在有在飞 Run 时挂着。
    runs_tick: native_sdk.EffectTimer,

    // ------------------------------------------------------------ 材料与设置
    material_draft_begin: Seeded,
    material_draft_typed: canvas.TextInputEvent,
    material_draft_cancel,
    /// 开始编辑一个 Agent 的专属 argv。
    agent_edit_begin: []const u8,
    agent_argv_typed: canvas.TextInputEvent,
    agent_edit_cancel,
    annotation_draft_typed: canvas.TextInputEvent,

    // ------------------------------------------------------------ 信箱
    mailbox_tab,

    // ------------------------------------------------------------ KARA
    kara_toggle,
    /// 窗口焦点：失焦时若在写作/评审就挂 8s 的离场判定。
    app_focus: bool,
    kara_gone_away: native_sdk.EffectTimer,
    /// 进场动画到点：补发 entered——v0.2.4 从没发过，机器卡在 Entering。
    kara_entered: native_sdk.EffectTimer,
    kara_leave_finished: native_sdk.EffectTimer,
    kara_card_done: native_sdk.EffectTimer,
    kara_interrupt_done: native_sdk.EffectTimer,

    // ------------------------------------------------------------ 通用
    /// 一条已经编好的项目请求（绘制侧用 `project_request.zig` 编的）。
    project_request: []const u8,
};

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "四个答复臂并成一个，路由由 key 给出" {
    // TS 侧 dispatch_ok/dispatch_err/save_ok/save_err 四个臂，在这里是一个 Msg
    // 加一次 key 判别——通道与成败都从载荷里读，不从臂名里读。
    const replay_seam = @import("../replay_seam.zig");
    const saved: Msg = .{ .host_result = .{
        .key = replay_seam.Channel.save.key(),
        .ok = true,
        .bytes = "",
    } };
    switch (saved) {
        .host_result => |result| {
            try testing.expectEqual(replay_seam.Channel.save, replay_seam.Channel.fromKey(result.key).?);
            try testing.expect(result.ok);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "去处臂拿枚举，越界的去处不可表示" {
    const go: Msg = .{ .workbench_go = .settings };
    switch (go) {
        .workbench_go => |destination| try testing.expectEqual(workbench.Destination.settings, destination),
        else => return error.TestUnexpectedResult,
    }
}

test "开盒只带 id 与起笔，不带预编好的请求" {
    // 这条测试钉住的是一个删除：`verdict_begin` 的载荷若哪天又长出
    // accept/reject 两串字节，就是摆渡字段回来了。
    const begin: Msg = .{ .verdict_begin = .{ .id = "p-1", .seed = "改后的话" } };
    switch (begin) {
        .verdict_begin => |seeded| {
            try testing.expectEqualStrings("p-1", seeded.id);
            try testing.expectEqualStrings("改后的话", seeded.seed);
            try testing.expectEqual(@as(usize, 2), @typeInfo(Seeded).@"struct".fields.len);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "定时器臂带着平台的触发时刻与它是不是真的烧到了" {
    // TS 车道捎的是核心自己编的 `at`，被拒的定时器与没挂上不可区分。
    const tick: Msg = .{ .runs_tick = .{ .key = 1, .timestamp_ns = 42, .outcome = .rejected } };
    switch (tick) {
        .runs_tick => |timer| {
            try testing.expectEqual(@as(u64, 42), timer.timestamp_ns);
            try testing.expectEqual(native_sdk.EffectTimerOutcome.rejected, timer.outcome);
        },
        else => return error.TestUnexpectedResult,
    }
}
