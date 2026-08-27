// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! KARA：回来卡、打断行、离场小结。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const native_sdk = @import("native_sdk");
const themes = @import("../generated/themes.zig");
const core = @import("../core.zig");
const veil = @import("../veil.zig");
const material_paint = @import("../material_paint.zig");
const Adapter = core.App;
const view_harness = @import("harness.zig");
const Model = core.Model;
const shell_view = @import("shell.zig");

/// 回来卡：「你停在这里」。
///
/// **接上哪个功能**：KARA 离开又回来后的状态恢复卡（2.3a）。600ms 自消
/// 在 core（卡计时器），这里只在 `karaCard` 立着时画。
///
/// **交互设计**：舞台规则豁免的浮层（Agent 状态恢复卡，唯一合法浮层
/// 之一）——叠放在正文轨顶，frame 定位，不进流、不随滚动。宽度沿用
/// 饭盒的那条公式（`verdictBento`），不新写几何。
pub fn karaReturnCard(ui: *Adapter.Ui, model: *const Model, column_width: f32, line_height: f32) Adapter.Ui.Node {
    if (!model.kara.card) return ui.el(.stack, .{ .height = 0 }, .{});
    const width = @min(@as(f32, 340), @max(@as(f32, 240), column_width));
    var card = ui.el(.panel, .{
        // 轨顶内缩 12（根栏间距的既有数）；高是一行加 padding 16。
        .frame = native_sdk.geometry.RectF.init(16, 12, width, line_height + 16),
        .padding = 8,
    }, .{
        ui.text(.{}, ui.fmt("你停在这里：{s}", .{model.kara.return_tail.slice()})),
    });
    // 回来卡同吃材质（2.10）：它是豁免浮层，但观感上与面板同一份配方。
    material_paint.apply(
        &card.widget,
        model.panel_material,
        &themes.themes[shell_view.currentThemeIndex(model)],
    );
    return card;
}

/// 打断行：KARA 计时被事实打断时的一句实话（保存失败、磁盘写不进……）。
/// `.alert` 部件画它——语义即「需要作者看一眼」。打断码的翻译表归
/// veil.zig（中文字面量纪律），不认识的码原样显示。
pub fn karaInterruptLine(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.kara.interrupt.slice().len == 0 or model.kara.state == 0) {
        return ui.el(.stack, .{ .height = 0 }, .{});
    }
    return ui.el(.alert, .{
        .semantics = .{ .label = "打断" },
    }, .{
        ui.text(.{}, veil.interruptLabel(model.kara.interrupt.slice())),
    });
}

/// 小结带：离场时把这一段发生的事讲一遍（`.status_bar` 部件——栏脚语义）。
/// queued 掩码逐位出文案，位序即显示序；什么都没有就说「这一段很安静。」。
pub fn karaSummaryStrip(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.kara.state != 5) return ui.el(.stack, .{ .height = 0 }, .{});
    return ui.el(.status_bar, .{
        .semantics = .{ .label = "离场小结" },
    }, .{
        ui.text(.{}, karaSummaryText(ui, model)),
    });
}

/// 小结文案：已保存 / Agent 完成了 / 提案到了 / 索引刷新了，按位序连接。
fn karaSummaryText(ui: *Adapter.Ui, model: *const Model) []const u8 {
    const queued = model.kara.queued;
    if (queued <= 0) return "这一段很安静。";
    var parts: [4][]const u8 = undefined;
    var count: usize = 0;
    if (queued & 1 != 0) {
        parts[count] = "已保存";
        count += 1;
    }
    if (queued & 2 != 0) {
        parts[count] = "Agent 完成了";
        count += 1;
    }
    if (queued & 4 != 0) {
        parts[count] = "提案到了";
        count += 1;
    }
    if (queued & 8 != 0) {
        parts[count] = "索引刷新了";
        count += 1;
    }
    return std.mem.join(ui.arena, " · ", parts[0..count]) catch "这一段很安静。";
}

test "KARA 静默时不画回来卡" {
    // 回来卡是打断之后的那一句话。没有打断过还画它，作者读到的是一次
    // 从未发生的中断。
    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    surface.ui = Adapter.Ui.init(surface.arena.allocator());
    const quiet = karaSummaryStrip(&surface.ui, &model);
    try std.testing.expectEqual(@as(usize, 0), view_harness.textCount(quiet));
}
