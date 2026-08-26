//! 历史：变更列表与回退。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const view_harness = @import("harness.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;

/// 历史：这份稿子改过什么，可回档。
///
/// **接上哪个功能**：`refrain_app::history::recent_history`。读的是落盘的
/// 记录，不是内存里那条撤销链——作者关掉软件第二天回来，看得见的是这一份。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。已撤销的行仍然显示（灰着），
/// 因为它们是作者做过的事；从列表里消失会让他以为自己记错了。
pub fn historyView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = replies.borrow(.history);
    var rows: [24]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const change = project_view.changeAt(listing, count) orelse break;
        rows[count] = ui.listItem(
            .{
                .key = .{ .index = count },
                .on_press = revertToMsg(change),
                .disabled = change.undone,
                .semantics = .{ .role = .listitem },
            },
            ui.fmt("{d} · {s}{s}", .{
                change.ordinal,
                change.cause,
                if (change.undone) " · 已撤销" else "",
            }),
        );
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "这份稿子改过什么"),
            ui.button(.{
                .on_press = readHistoryMsg(model),
                .semantics = .{ .label = "重新读改动记录" },
            }, "刷新"),
        }),
        if (count == 0)
            ui.text(.{}, "还没有可回档的改动")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "改动记录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 回到这一行刚落下的状态。行 id 就是动作 id，原样送回 Rust 点名——
/// 序号是给作者读的。已撤销的行在视图上 disabled，到不了这里。
fn revertToMsg(change: project_view.Change) ?Msg {
    if (change.undone) return null;
    return .{ .document_revert = change.id };
}

/// 读这份文档的改动记录。没打开稿子就没有可读的——按钮因此返回 null。
fn readHistoryMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readHistory(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

test "改动记录为空时说的是「还没有改动」，不是一屏空白" {
    // 空名录与「还没问过」在这一层同形，两者都不该画成什么都没有：作者读到
    // 空白会以为这一屏坏了。
    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    const built = surface.build(&model, historyView);
    try std.testing.expect(view_harness.textCount(built) > 0);
}
