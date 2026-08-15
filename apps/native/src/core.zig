//! Zig 核心：`Model`、`Msg`、`update`。
//!
//! 这是 `core.ts` 的去处。今天它还没有生产读者——`app.zon` 仍指向 TS 车道，切换在
//! 单元 13。届时这个名字落到唯一的权威上，`core.ts` 与它的四个同伙一起删。
//!
//! **薄状态机**（PLAN §0-2）：域规则一律在 Rust。这里只有去处、面板栈、滚动、旗标
//! 与草稿缓冲。凡是「要判断这件事对不对」的地方都过桥问 Rust；本模块判的只是
//! 「现在该显示什么」。
//!
//! **迁移进度写在类型里而不是写在注释里**：`pending_arms` 列出还没迁的臂，一条
//! 测试保证那张表里的每个名字都是真的 `Msg` 臂——名字拼错或臂改名都会红。迁一个
//! 就从表里删一个，于是「还剩多少」是可数的，不是靠印象。
//!
//! 规格：`RefRain-work/main+SPEC.md`。

const std = @import("std");
const native_sdk = @import("native_sdk");
const workbench = @import("core/workbench.zig");
const roster = @import("core/roster.zig");
const model_mod = @import("core/model.zig");
const msg_mod = @import("core/msg.zig");
const replay_seam = @import("replay_seam.zig");
const protocol = @import("generated/protocol.zig");

pub const Model = model_mod.Model;
pub const Msg = msg_mod.Msg;
pub const Destination = workbench.Destination;

pub const App = native_sdk.UiApp(Model, Msg);
pub const Effects = App.Effects;

/// 还没迁过来的臂（12e 与 12f 的工作面）。
///
/// 它们今天在 `update` 里明确地什么都不做，而不是落进一个 `else` 分支——`else` 会
/// 让「忘了迁」与「有意不动」看起来一样。这张表让剩余工作可数。
pub const pending_arms = [_][]const u8{
    // 12e：要读答复才能决定的臂。
    "host_result",        "document_input",         "document_scroll",
    "document_save",      "document_undo",          "document_jump",
    "document_revert",    "document_open",          "document_open_jump",
    "project_request",    "search_fire",            "verdict_begin",
    "verdict_accept",     "verdict_reject",         "verdict_revise",
    "verdict_settle",     "desk_verdict",           "review_advance",
    "revision_begin",     "material_draft_begin",   "agent_edit_begin",
    "dispatch_agents",    "dispatch_orchestration", "dispatch_block_toggle",
    "dispatch_blocks_all", "dispatch_blocks_clear", "dispatch_carry",
    "dispatch_agent",     "dispatch_material_toggle", "dispatch_stash",
    "dispatch_stash_drop", "dispatch_stash_clear",  "runs_tick",
    "stale_dismiss",      "mailbox_tab",
    // 12f：KARA 的计时与开关（机器在 Rust，这里只接计时）。
    "kara_toggle",        "app_focus",              "kara_gone_away",
    "kara_entered",       "kara_leave_finished",    "kara_card_done",
    "kara_interrupt_done", "app_quit",              "frame",
    "theme_select",       "material_select",
};

/// 启动：向 Rust 握一次手。
///
/// 只握一次（`core.ts` 同）。握手的答复落地时连带把读设置发出去，排版三值与主题
/// 随它回来——设置页与正文首帧因此不必等作者先按一次「读取设置」。
pub fn initFx(model: *Model, fx: *Effects) void {
    model.* = .{};
    var buffer: [replay_seam.max_record_bytes]u8 = undefined;
    const record = replay_seam.encode(&buffer, .{ .action = .health }) catch return;
    replay_seam.request(fx, .dispatch, record, Effects.hostMsg(.host_result));
}

/// 一件事发生之后，界面变成什么样。
///
/// 就地改而不是造一个新值：`UiApp` 的 `update_fx` 拿的是 `*Model`。TS 车道必须恒返
/// `[Model, Cmd]` 元组（编译产物对混形糖的窄化会断裂，v0.3.0 真窗首派崩溃的根因），
/// 那条纪律随车道一起消失。
pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    _ = fx;
    // 探头态的解除在分派之前：任何交互都算「作者用过这栏」——栏留下，解除的只是
    // 自动收回的资格。机器自己的动静（计时、答复、帧）不解除。
    if (model.rail_peek and !keepsPeek(msg)) model.rail_peek = false;

    switch (msg) {
        // ---------------------------------------------------------- 去处与面板
        .workbench_go => |target| goTo(model, target),
        .workbench_key => |ordinal| {
            const target = workbench.destinationForOrdinal(ordinal, model.agent_destination) orelse return;
            goTo(model, target);
        },
        .panel_back => {
            const popped = model.panel_stack.pop();
            model.panel_stack = popped.rest;
            model.destination = workbench.settleAfterDocument(popped.destination, model.hasDocument());
            relayout(model);
        },
        .rail_peek_open => {
            if (model.destination == .files) return;
            model.panel_stack = model.panel_stack.push(model.destination);
            model.destination = .files;
            model.rail_peek = true;
            relayout(model);
        },
        .rail_peek_close => {
            // 栏被动过就留下：解除探头态的是交互，不是指针离开。
            if (!model.rail_peek or model.destination != .files) return;
            backToManuscript(model);
            model.rail_peek = false;
        },
        .split_resize => |fraction| {
            model.rail_fraction = workbench.clampRailFraction(fraction);
            relayout(model);
        },

        // ---------------------------------------------------------- 浮层
        .palette_toggle => {
            model.palette.open = !model.palette.open;
            // 每次打开都是一次新的「我要去…」。
            model.palette.query.clear();
        },
        .palette_query => |event| _ = model.palette.query.applyEdit(event),
        .notice_dismiss => model.notice = null,
        .noop => {},

        // ---------------------------------------------------------- 外观
        .theme_next => model.theme_index = nextTheme(model.theme_index),

        // ---------------------------------------------------------- 名录
        .roster_step => |delta| {
            if (!model.destination.hasRoster()) return;
            model.roster_cursor = roster.step(model.roster_cursor, delta, model.roster_count);
        },

        // ---------------------------------------------------------- 搜索
        .search_typed => |event| _ = model.search.query.applyEdit(event),
        .search_precision => model.search.exact = !model.search.exact,

        // ---------------------------------------------------------- 草稿
        .revision_typed => |event| _ = model.revising.body.applyEdit(event),
        .revision_cancel => model.revising = .{},
        .material_draft_typed => |event| _ = model.material_draft.body.applyEdit(event),
        .material_draft_cancel => model.material_draft = .{},
        .agent_argv_typed => |event| _ = model.editing_agent.body.applyEdit(event),
        .agent_edit_cancel => model.editing_agent = .{},
        .dispatch_typed => |event| _ = model.dispatch.prompt.applyEdit(event),
        .annotation_draft_typed => |event| _ = model.annotation_draft.applyEdit(event),

        // ---------------------------------------------------------- 裁决台的界面半边
        .review_reason_open => {
            model.review.reason_open = true;
            // 起笔是已记下的理由。
            model.review.reason_draft = model.review.reason;
        },
        .review_reason_typed => |event| _ = model.review.reason_draft.applyEdit(event),
        .review_reason_commit => {
            // 空串也是一条记下的理由——「有没有」由旗说，不由长度说。
            model.review.reason = model.review.reason_draft;
            model.review.reason_recorded = true;
            model.review.reason_open = false;
        },
        .review_reason_cancel => {
            // 当作没问过：草稿丢掉，已记下的不动。
            model.review.reason_draft.clear();
            model.review.reason_open = false;
        },
        .review_peer => model.review.peer = !model.review.peer,
        .verdict_close => model.review.proposal.clear(),

        // ---------------------------------------------------------- 还没迁的臂
        // 明确地什么都不做。见 `pending_arms`：迁一个就从那张表里删一个。
        else => {},
    }
}

/// 这条消息不算「作者用过这栏」吗。
///
/// 两类：机器自己的动静（帧、计时、答复），以及**探头态自己的两条**。
/// 后一类必须在这里：指针离开不是一次交互，而 `rail_peek_close` 的臂要读那面旗
/// 才能决定收不收回——分派之前先把旗清了，它永远看到「栏被动过」，于是探头
/// 开出来的栏再也收不回去。测试当场抳到了这一条。
fn keepsPeek(msg: Msg) bool {
    return switch (msg) {
        .rail_peek_open, .rail_peek_close => true,
        .frame, .host_result, .app_focus => true,
        .runs_tick, .search_fire => true,
        .kara_gone_away, .kara_entered, .kara_leave_finished => true,
        .kara_card_done, .kara_interrupt_done => true,
        // 两条 `core.ts` 没列而这里列了，理由同一条：它们也不是作者的动作。
        // `noop` 是滑杆没跨过一个步距；`review_advance` 是判后 120ms 的延迟前进。
        .noop, .review_advance => true,
        else => false,
    };
}

/// 去某个去处，按 `workbench.navigate` 的裁定落地。
fn goTo(model: *Model, target: Destination) void {
    switch (workbench.navigate(model.destination, target, model.hasDocument())) {
        .moved => {
            model.panel_stack = model.panel_stack.push(model.destination);
            model.destination = target;
            // Cmd+4 记住的是 Agent 层的去处。
            if (target.isAgent()) model.agent_destination = target;
            relayout(model);
        },
        // 同键再按：回正文，不是再看一遍同一个面板。
        .close => backToManuscript(model),
        .unchanged => {},
        .needs_document => {
            var line: model_mod.Line = .empty;
            _ = line.setTruncated("先打开一份稿子。");
            model.notice = line;
        },
    }
}

fn backToManuscript(model: *Model) void {
    model.destination = .manuscript;
    model.panel_stack = .empty;
    relayout(model);
}

/// 分栏投影：唯一的权威在 `workbench.layoutFraction`，Model 只持结果。
fn relayout(model: *Model) void {
    model.layout_fraction = workbench.layoutFraction(model.destination, model.rail_fraction);
}

/// 换下一套主题，到末尾回到第一套。
fn nextTheme(current: u8) u8 {
    const themes = @import("generated/themes.zig");
    const count: u8 = @intCast(themes.themes.len);
    if (count == 0) return 0;
    return (current + 1) % count;
}

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "还没迁的臂表里每个名字都是真的 Msg 臂" {
    // 这条测试让迁移进度可数：名字拼错、臂改名、臂删掉，都在这里红。
    const arms = @typeInfo(Msg).@"union".fields;
    for (pending_arms) |pending| {
        var found = false;
        inline for (arms) |arm| {
            if (std.mem.eql(u8, arm.name, pending)) found = true;
        }
        if (!found) {
            std.debug.print("pending_arms 里的 `{s}` 不是 Msg 的臂\n", .{pending});
            return error.TestUnexpectedResult;
        }
    }
    // 已迁 = 总数 − 待迁。数字写进断言，掉了会红。
    try testing.expectEqual(@as(usize, 74), arms.len);
    try testing.expectEqual(@as(usize, 46), pending_arms.len);
    // 已迁 28 臂。这个数字每迁一批就长一次,它是单元 12 的进度条。
    try testing.expectEqual(@as(usize, 28), arms.len - pending_arms.len);
}

test "导航：够得着就走，够不着就说为什么" {
    var model: Model = .{};
    var fx: Effects = undefined;
    // 裁决台要一份稿子；没有稿子时不动去处，留下一句话。
    update(&model, .{ .workbench_go = .review }, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);
    try testing.expect(model.notice != null);

    // 读过了那句话。
    update(&model, .notice_dismiss, &fx);
    try testing.expectEqual(@as(?model_mod.Line, null), model.notice);

    // 有稿子就走得动，并且把来路压进栈。
    model.document.session = 1;
    update(&model, .{ .workbench_go = .review }, &fx);
    try testing.expectEqual(Destination.review, model.destination);
    try testing.expectEqual(@as(u8, 0), model.panel_stack.depth); // 稿子是根，不进栈
    // 裁决是 Agent 层：Cmd+4 记住了它。
    try testing.expectEqual(Destination.review, model.agent_destination.?);
}

test "同键再按回正文，退层回上一个去处" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    update(&model, .{ .workbench_go = .files }, &fx);
    update(&model, .{ .workbench_go = .dispatch }, &fx);
    try testing.expectEqual(Destination.dispatch, model.destination);
    try testing.expectEqual(@as(u8, 1), model.panel_stack.depth);

    // 退层：回文件区。
    update(&model, .panel_back, &fx);
    try testing.expectEqual(Destination.files, model.destination);

    // 同键再按：回正文，栈清空。
    update(&model, .{ .workbench_go = .files }, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);
    try testing.expectEqual(@as(u8, 0), model.panel_stack.depth);
}

test "四区键位与分栏投影一起动" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    // Cmd+2 去文件区：分栏比例跟着变成侧栏宽。
    update(&model, .{ .workbench_key = 2 }, &fx);
    try testing.expectEqual(Destination.files, model.destination);
    try testing.expectEqual(workbench.rail_fraction_default, model.layout_fraction);
    // 拖分隔条：钳进可用区间，投影跟着更新。
    update(&model, .{ .split_resize = 0.9 }, &fx);
    try testing.expectEqual(@as(f64, 0.4), model.rail_fraction);
    try testing.expectEqual(@as(f64, 0.4), model.layout_fraction);
    // 键位序号越界：这一下不接管，什么都不动。
    update(&model, .{ .workbench_key = 9 }, &fx);
    try testing.expectEqual(Destination.files, model.destination);
}

test "探头态：交互留下栏，机器的动静不解除" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    update(&model, .rail_peek_open, &fx);
    try testing.expect(model.rail_peek);
    try testing.expectEqual(Destination.files, model.destination);

    // 机器自己的动静不解除探头态。
    update(&model, .noop, &fx);
    try testing.expect(model.rail_peek);
    // 指针移出：栏没被动过，收回稿子。
    update(&model, .rail_peek_close, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);

    // 这次作者用过栏（一次交互），指针移出就不该收回。
    update(&model, .rail_peek_open, &fx);
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expect(!model.rail_peek);
    update(&model, .rail_peek_close, &fx);
    try testing.expectEqual(Destination.files, model.destination);
}

test "名录键只在有名录的去处上动" {
    var model: Model = .{ .document = .{ .session = 1 }, .roster_count = 3 };
    var fx: Effects = undefined;
    // 稿子上没有名录：游标不动，免得作者回到台上时位置已经漂了。
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expectEqual(@as(?u32, null), model.roster_cursor);

    update(&model, .{ .workbench_go = .dispatch }, &fx);
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expectEqual(@as(?u32, 1), model.roster_cursor);
    // 撞到末端就停，不绕回。
    update(&model, .{ .roster_step = 9 }, &fx);
    try testing.expectEqual(@as(?u32, 2), model.roster_cursor);
}

test "理由框：空串也是一条记下的理由，取消不动已记下的" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .review_reason_open, &fx);
    try testing.expect(model.review.reason_open);
    update(&model, .{ .review_reason_typed = .{ .insert_text = "太长" } }, &fx);
    update(&model, .review_reason_commit, &fx);
    try testing.expect(model.review.reason_recorded);
    try testing.expectEqualStrings("太长", model.review.reason.slice());
    try testing.expect(!model.review.reason_open);

    // 再开一次，打了字又取消：已记下的不动。
    update(&model, .review_reason_open, &fx);
    update(&model, .{ .review_reason_typed = .{ .insert_text = "改主意" } }, &fx);
    update(&model, .review_reason_cancel, &fx);
    try testing.expectEqualStrings("太长", model.review.reason.slice());
    try testing.expect(!model.review.reason_open);
}

test "命令面板每次打开都是新的一次" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .palette_toggle, &fx);
    update(&model, .{ .palette_query = .{ .insert_text = "裁决" } }, &fx);
    try testing.expectEqualStrings("裁决", model.palette.query.slice());
    update(&model, .palette_toggle, &fx);
    update(&model, .palette_toggle, &fx);
    // 上次的一半查询会让作者以为面板没刷新。
    try testing.expect(model.palette.query.isEmpty());
    try testing.expect(model.palette.open);
}
