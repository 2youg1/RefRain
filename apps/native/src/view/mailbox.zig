//! 信箱：三格、排序、冲销。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const review_view = @import("review.zig");

/// 信箱：Agent 提了什么、作者怎么安排，以及送出去的 Run 走到哪了。
///
/// **接上哪个功能**：`ReadMailbox`／`MailboxPin`／`MailboxDiscard`／`Countermand`，
/// 与编排的 `readHost`／`hostCommand`／`collect`。答复共用 `projectResult` 一个
/// 槽——最后一封答复是什么形状，这一屏就画哪一段；两个刷新按钮各取一份，
/// 信箱动作（置顶、弃置、冲销）的答复本身就是刷新后的信箱，不必再发一条读。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。格与 Pin 归 `refrain_app::mailbox`，
/// Run 允许什么动作归 `project_view.runActions`——这里一条规则也不复制。
/// 空信箱说话而不是留白：什么都不画会被读成界面坏了。
pub fn mailboxView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.root_id.slice().len == 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, "送出去的那些"),
            ui.text(.{}, "先打开一个项目"),
        });
    }
    const reply = replies.borrow(.mailbox);
    var children: [2 * shell_view.card_rows + 2]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    // 页签决定读哪份投影；未读数只在默认列表有意义，回收站里数它
    // 会数出「刚放弃的那批」——那不是未读。
    const discarded = model.mailbox_discarded;
    const unread = if (discarded) 0 else blk: {
        var seen: usize = 0;
        var walk: usize = 0;
        while (walk < shell_view.card_rows) : (walk += 1) {
            const entry = project_view.mailboxEntryAt(reply, walk) orelse break;
            if (entry.box == .unread) seen += 1;
        }
        break :blk seen;
    };
    children[count] = ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{ .grow = 1 }, if (discarded) "回收站" else "信箱"),
        if (!discarded and unread > 0)
            ui.text(.{}, ui.fmt("{d} 未读", .{unread}))
        else
            ui.spacer(0),
        ui.button(.{
            .on_press = .{ .mailbox_tab = {} },
            .semantics = .{ .label = if (discarded) "回默认信箱" else "看回收站" },
        }, if (discarded) "默认" else "回收站"),
        ui.button(.{
            .on_press = readMailboxMsg(model),
            .semantics = .{ .label = "重新读信箱" },
        }, "刷新"),
        ui.button(.{
            .on_press = readHostMsg(model),
            .semantics = .{ .label = "重新读派发的状况" },
        }, "刷新派发"),
    });
    count += 1;
    var drawn: usize = 0;
    while (drawn < shell_view.card_rows) : (drawn += 1) {
        const entry = project_view.mailboxEntryAt(reply, drawn) orelse break;
        const prev = if (drawn > 0) project_view.mailboxEntryAt(reply, drawn - 1) else null;
        const next = project_view.mailboxEntryAt(reply, drawn + 1);
        children[count] = mailboxCard(ui, model, entry, drawn, prev, next, discarded);
        count += 1;
    }
    var found = drawn;
    // Run 段：同一屏的另一半。`runs` 只在 host 形状的答复里有，信箱形状
    // 的答复里它是空数组——两段不会同时满，也不会因为另一段而错位。
    const host = replies.borrow(.host);
    const runs: []const wire.RunRow = if (host.head(.host)) |head|
        host.rows(wire.RunRow, head.runs)
    else
        &[_]wire.RunRow{};
    var run_index: usize = 0;
    while (run_index < @min(shell_view.card_rows, runs.len)) : (run_index += 1) {
        children[count] = runCard(ui, model, host, runs[run_index], run_index);
        count += 1;
    }
    found += run_index;
    if (found == 0) {
        children[count] = ui.text(.{}, if (discarded) "回收站是空的" else "信箱是空的");
        count += 1;
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, @as([]const Adapter.Ui.Node, children[0..count]));
}

/// 一单提案的卡片：它落在哪份文档、要改哪里、到哪一步了，和它的安排动作。
///
/// 冲销只给「已处理」的单——它退回的是账本里已有的裁决行，对一封还没判过
/// 的提案按冲销，Rust 只会具名拒绝。回收站页签（`discarded`）里同一张卡片
/// 换两个动作：取回（软删除可逆）与重新弃置的确认交给 Rust 的幂等语义。
/// 位次交换只在双方都有位次时可用——`prev`／`next` 带上邻居的 id 与位次，
/// 交换是两条 `mailboxRank`（自己落邻居的位次、邻居落自己的），Rust 侧
/// 每次只落一个数字。
fn mailboxCard(
    ui: *Adapter.Ui,
    model: *const Model,
    entry: project_view.MailboxEntry,
    index: usize,
    prev: ?project_view.MailboxEntry,
    next: ?project_view.MailboxEntry,
    discarded: bool,
) Adapter.Ui.Node {
    const done = entry.box == .done;
    const can_move = !discarded and entry.rank != null;
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            ui.text(.{}, ui.fmt("{s} · {s}{s}", .{
                entry.document,
                entry.scope,
                if (entry.pinned) " · 已置顶" else "",
            })),
            ui.text(.{}, ui.fmt("{s} · {s}", .{ entry.box_label, entry.before_text })),
            if (discarded)
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.button(.{
                        .on_press = mailboxRestoreMsg(model, entry),
                        .semantics = .{ .label = "取回这一单" },
                    }, "取回"),
                    ui.button(.{
                        .on_press = mailboxDiscardMsg(model, entry),
                        .semantics = .{ .label = "从回收站再弃置（空操作）" },
                    }, "弃置"),
                })
            else
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.button(.{
                        .disabled = !(can_move and prev != null and prev.?.rank != null),
                        .on_press = if (can_move and prev != null and prev.?.rank != null)
                            mailboxSwapMsg(model, entry, prev.?)
                        else
                            null,
                        .semantics = .{ .label = "这一单上移一位" },
                    }, "上移"),
                    ui.button(.{
                        .disabled = !(can_move and next != null and next.?.rank != null),
                        .on_press = if (can_move and next != null and next.?.rank != null)
                            mailboxSwapMsg(model, entry, next.?)
                        else
                            null,
                        .semantics = .{ .label = "这一单下移一位" },
                    }, "下移"),
                    ui.button(.{
                        .on_press = mailboxPinMsg(model, entry),
                        .semantics = .{ .label = if (entry.pinned) "取消置顶这一单" else "置顶这一单" },
                    }, if (entry.pinned) "取消置顶" else "置顶"),
                    ui.button(.{
                        .on_press = mailboxDiscardMsg(model, entry),
                        .semantics = .{ .label = "弃置这一单" },
                    }, "弃置"),
                    ui.button(.{
                        .disabled = !done,
                        .on_press = countermandMsg(model, entry),
                        .semantics = .{ .label = "冲销这一单的裁决" },
                    }, "冲销"),
                }),
        }),
    });
}

/// 一个 Run 的卡片：状态、允许的动作，和「需要恢复」这句作者必须读到的话。
///
/// **这是 F-08 的修法。** 旧栈为所有非终态 Run 显示「取消」，于是重启后的
/// Dispatched Run 上有一个后端必然拒绝的按钮。允许什么由状态本身说。
fn runCard(
    ui: *Adapter.Ui,
    model: *const Model,
    host: wire.Reply,
    row: wire.RunRow,
    index: usize,
) Adapter.Ui.Node {
    const run_id = host.text(row.id);
    const rendered = project_view.runRow(host, row) orelse
        return ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    const actions = project_view.runActions(row);
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            ui.text(.{}, ui.fmt("{s} · {s}", .{ rendered.label, rendered.detail })),
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.button(.{
                    // 开始仅已授权可按（2.11）：与派发台同一条发令枪，
                    // 两处不说两种话。
                    .disabled = !actions.launchable,
                    .on_press = review_view.launchRunMsg(model, run_id),
                    .semantics = .{ .label = "发射这一次派发" },
                }, "开始"),
                ui.button(.{
                    .disabled = !actions.cancellable,
                    .on_press = runCommandMsg("cancelRun", model, run_id),
                    .semantics = .{ .label = "取消这一次派发" },
                }, "取消"),
                ui.button(.{
                    .disabled = !actions.retryable,
                    .on_press = runCommandMsg("retryRun", model, run_id),
                    .semantics = .{ .label = "重试这一次派发" },
                }, "重试"),
                ui.button(.{
                    // 收取随时可按：结果还没出现是 `waiting` 那一态，不是错误。
                    .on_press = review_view.collectRunMsg(model, run_id),
                    .semantics = .{ .label = "收取这一次派发的结果" },
                }, "收取"),
            }),
            // 待恢复不是一个诊断字段，是作者必须能读到的产品状态。
            if (actions.needs_recovery)
                ui.text(.{}, "这一条需要恢复：重启后它没有活着的进程")
            else
                ui.spacer(1),
        }),
    });
}

/// 读信箱。没有 Root 就没有信箱——按钮因此返回 null。
fn readMailboxMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMailbox(&writer, model.root_id.slice(), model.mailbox_discarded) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 取回一弃置的单。页签上下文就是它的出处——行本身不带弃置标记。
fn mailboxRestoreMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxRestore(&writer, model.root_id.slice(), entry.id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 与相邻一单交换位次。交换是 Rust 侧的一次事务（`mailboxSwap`）——
/// 两条 `mailboxRank` 拼不出原子交换，界面只发一条。
fn mailboxSwapMsg(
    model: *const Model,
    entry: project_view.MailboxEntry,
    neighbor: project_view.MailboxEntry,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    _ = entry.rank orelse return null;
    _ = neighbor.rank orelse return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxSwap(&writer, model.root_id.slice(), entry.id, neighbor.id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读编排名录：Run 那一半的数据从这条来。
pub fn readHostMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readHost(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 置顶或取消置顶一单。格名取自行本身——它是安排表点名的依据，不是显示文本。
fn mailboxPinMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxPin(
        &writer,
        model.root_id.slice(),
        entry.id,
        project_view.boxWireName(entry.box),
        !entry.pinned,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 弃置一单：软删除，它从默认列表消失，提案行与账本原封不动（INV-4）。
fn mailboxDiscardMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxDiscard(
        &writer,
        model.root_id.slice(),
        entry.id,
        project_view.boxWireName(entry.box),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 冲销一单已裁决的提案。`document` 是 Root 相对路径——`Countermand` 按
/// 文档取回稿子，跨界的是路径而不是绝对地址。
fn countermandMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.countermand(
        &writer,
        model.root_id.slice(),
        entry.document,
        entry.id,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 一条只带 Run id 的编排命令，编成 `project_request` 消息。
///
/// 编码缓冲每次现取：请求出不了这一帧——它随 Msg 提交时被复制进 Model 的
/// 堆，这正是它的寿命。
pub fn runCommandMsg(
    comptime command: []const u8,
    model: *const Model,
    run_id: []const u8,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.hostRunCommand(
        &writer,
        model.root_id.slice(),
        command,
        run_id,
        // 宿主自己没有钟：时刻随命令过河，它的事实才可重放。
        if (std.mem.eql(u8, command, "retryRun")) null else 0,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}
